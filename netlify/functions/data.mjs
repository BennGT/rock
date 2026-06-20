import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

export default async function handler(request) {
  try {
    if (request.method === "OPTIONS") {
      return new Response("", { status: 204, headers });
    }

    const store = getMarshalStore("marshal");
    const authStore = getMarshalStore("marshal-auth");
    const user = await getAuthenticatedUser(authStore, request.headers.get("authorization"));

    if (!user) {
      return json(401, { error: "Sign in required" });
    }

    if (request.method === "GET") {
      const data = await store.get("shared-data", { type: "json" });
      return json(200, { data: data ? dataForUser(data, user) : null });
    }

    if (request.method === "POST") {
      const payload = await request.json().catch(() => ({}));
      const data = payload.data || payload;

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return json(400, { error: "Invalid data payload" });
      }

      const currentData = (await store.get("shared-data", { type: "json" })) || {};
      const nextData = isOwnerAdmin(user)
        ? mergeAdminData(currentData, data)
        : isManager(user)
          ? mergeManagerData(currentData, data, user)
          : mergeEmployeeData(currentData, data, user);

      await store.setJSON("shared-data", {
        ...nextData,
        cloudSavedAt: new Date().toISOString(),
      });

      return json(200, { ok: true });
    }

    return json(405, { error: "Method not allowed" });
  } catch (error) {
    console.error(error);
    return json(500, {
      error: "Data function failed",
      detail: error.message,
      name: error.name,
    });
  }
}

function mergeAdminData(currentData, incomingData) {
  const deletedMessageIds = mergeDeletedIds(currentData.deletedMessageIds, incomingData.deletedMessageIds);
  const deletedRequestIds = mergeDeletedIds(currentData.deletedRequestIds, incomingData.deletedRequestIds);
  return {
    ...incomingData,
    deletedMessageIds,
    deletedRequestIds,
    messages: mergeById(currentData.messages, incomingData.messages).filter((message) => !deletedMessageIds.includes(message.id)),
    requests: mergeById(currentData.requests, incomingData.requests).filter((request) => !deletedRequestIds.includes(request.id)),
  };
}

function mergeManagerData(currentData, incomingData, user) {
  const ownData = mergeEmployeeData(currentData, incomingData, user);
  const deletedMessageIds = Array.isArray(currentData.deletedMessageIds) ? currentData.deletedMessageIds : [];
  const deletedRequestIds = Array.isArray(currentData.deletedRequestIds) ? currentData.deletedRequestIds : [];

  return {
    ...currentData,
    deletedMessageIds,
    deletedRequestIds,
    employees: ownData.employees || currentData.employees,
    shifts: mergeById(currentData.shifts, incomingData.shifts),
    messages: ownData.messages || currentData.messages,
    requests: ownData.requests || currentData.requests,
    savedAt: incomingData.savedAt || currentData.savedAt,
  };
}

function mergeEmployeeData(currentData, incomingData, user) {
  let employeeId = findEmployeeIdForUser(currentData, user);

  const currentMessages = Array.isArray(currentData.messages) ? currentData.messages : [];
  const incomingMessages = Array.isArray(incomingData.messages) ? incomingData.messages : [];
  const deletedMessageIds = Array.isArray(currentData.deletedMessageIds) ? currentData.deletedMessageIds : [];
  const currentMessageIds = new Set(currentMessages.map((message) => message.id));
  const incomingMessageMap = new Map(incomingMessages.filter((message) => message.id).map((message) => [message.id, message]));
  const messagesWithOwnHidden = currentMessages.map((message) => {
    if (message.employeeId !== employeeId) return message;
    const incoming = incomingMessageMap.get(message.id);
    if (!incoming?.hiddenForUserIds?.includes(user.id)) return message;
    return {
      ...message,
      hiddenForUserIds: mergeDeletedIds(message.hiddenForUserIds, [user.id]),
    };
  });
  const newOwnMessages = incomingMessages.filter(
    (message) => message.employeeId === employeeId && message.id && !currentMessageIds.has(message.id) && !deletedMessageIds.includes(message.id),
  );

  const currentRequests = Array.isArray(currentData.requests) ? currentData.requests : [];
  const incomingRequests = Array.isArray(incomingData.requests) ? incomingData.requests : [];
  const deletedRequestIds = Array.isArray(currentData.deletedRequestIds) ? currentData.deletedRequestIds : [];
  const otherRequests = currentRequests.filter((request) => request.employeeId !== employeeId && !deletedRequestIds.includes(request.id));
  const ownRequests = incomingRequests
    .filter((request) => request.employeeId === employeeId && request.id && !deletedRequestIds.includes(request.id))
    .map((request) => {
      const existing = currentRequests.find((item) => item.id === request.id);
      return {
        ...request,
        status: existing?.status || request.status || "Pending",
      };
    });

  const incomingEmployees = Array.isArray(incomingData.employees) ? incomingData.employees : [];
  let incomingEmployee = incomingEmployees.find((employee) => employee.id === employeeId);
  if (!employeeId) {
    incomingEmployee = incomingEmployees.find((employee) => normalizeEmail(employee.email) === normalizeEmail(user.email));
    employeeId = incomingEmployee?.id || null;
  }

  const currentEmployees = Array.isArray(currentData.employees) ? currentData.employees : [];
  if (incomingEmployee && !findEmployeeIdForUser(currentData, user)) {
    const existingBlankProfile = currentEmployees.find(
      (employee) =>
        !normalizeEmail(employee.email) &&
        cleanText(employee.name).toLowerCase() === cleanText(incomingEmployee.name || user.name).toLowerCase(),
    );
    if (existingBlankProfile) employeeId = existingBlankProfile.id;
  }
  const employees = incomingEmployee
    ? upsertOwnEmployee(currentEmployees, incomingEmployee, user, employeeId)
    : currentEmployees;

  if (!employeeId) return currentData;

  return {
    ...currentData,
    deletedMessageIds,
    deletedRequestIds,
    employees,
    messages: [...messagesWithOwnHidden, ...newOwnMessages].filter((message) => !deletedMessageIds.includes(message.id)),
    requests: [...ownRequests, ...otherRequests],
    savedAt: incomingData.savedAt || currentData.savedAt,
  };
}

function upsertOwnEmployee(currentEmployees, incomingEmployee, user, employeeId) {
  const ownId = employeeId || incomingEmployee.id || crypto.randomUUID();
  const existingIndex = currentEmployees.findIndex((employee) => employee.id === ownId);
  const existing = existingIndex >= 0 ? currentEmployees[existingIndex] : {};
  const ownEmployee = {
    ...existing,
    id: existing.id || ownId,
    name: cleanText(incomingEmployee.name),
    initials: cleanText(incomingEmployee.initials).slice(0, 3).toUpperCase() || makeInitials(incomingEmployee.name),
    role: existing.role || "Team member",
    email: normalizeEmail(user.email),
    phone: cleanText(incomingEmployee.phone),
    nextOfKinName: cleanText(incomingEmployee.nextOfKinName),
    nextOfKinPhone: cleanText(incomingEmployee.nextOfKinPhone),
    color: cleanColor(incomingEmployee.color) || existing.color || colorForText(user.email),
    color2: cleanColor(incomingEmployee.color2) || existing.color2 || "#087aa3",
    color3: cleanColor(incomingEmployee.color3) || existing.color3 || "#d84a2a",
    avatar: incomingEmployee.avatar?.dataUrl ? incomingEmployee.avatar : existing.avatar || null,
    status: existing.status || "Available",
    profileComplete: Boolean(cleanText(incomingEmployee.name) && cleanText(incomingEmployee.initials)),
  };

  if (existingIndex >= 0) {
    return currentEmployees.map((employee) => {
      if (employee.id !== ownId) return employee;
        return {
          ...employee,
          ...ownEmployee,
        };
    });
  }

  return [...currentEmployees, ownEmployee];
}

function findEmployeeIdForUser(data, user) {
  const employees = Array.isArray(data.employees) ? data.employees : [];
  return employees.find((employee) => normalizeEmail(employee.email) === normalizeEmail(user.email))?.id || null;
}

function dataForUser(data, user) {
  if (isOwnerAdmin(user)) return data;

  const employeeId = findEmployeeIdForUser(data, user);
  const employees = Array.isArray(data.employees) ? data.employees : [];
  const manager = isManager(user);

  return {
    ...data,
    currentUserId: employeeId,
    employees: employees.map((employee) => {
      if (employee.id === employeeId) return employee;
      return {
        id: employee.id,
        name: employee.name,
        initials: employee.initials,
        role: employee.role,
        status: employee.status,
        color: employee.color,
        color2: employee.color2,
        color3: employee.color3,
        avatar: employee.avatar || null,
        email: "",
        phone: "",
        nextOfKinName: "",
        nextOfKinPhone: "",
      };
    }),
    shifts: Array.isArray(data.shifts) ? data.shifts.filter((shift) => manager || shift.published) : [],
    messages: Array.isArray(data.messages)
      ? data.messages.filter((message) => !Array.isArray(message.hiddenForUserIds) || !message.hiddenForUserIds.includes(user.id))
      : [],
    requests: Array.isArray(data.requests) ? data.requests.filter((request) => manager || request.employeeId === employeeId) : [],
  };
}

function isOwnerAdmin(user) {
  return user?.role === "admin";
}

function isManager(user) {
  return user?.role === "manager";
}

function cleanText(value) {
  return String(value || "").trim();
}

function makeInitials(name) {
  return String(name || "")
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 3)
    .toUpperCase();
}

function colorForText(text) {
  const palette = ["#a33a24", "#087aa3", "#d84a2a", "#211a17", "#0f766e", "#9a6700", "#7c3aed", "#be123c"];
  const value = String(text || "");
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) % palette.length;
  }
  return palette[hash] || palette[0];
}

function cleanColor(color) {
  const value = String(color || "").trim();
  return /^#[0-9a-f]{6}$/i.test(value) ? value : "";
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function mergeById(currentItems = [], incomingItems = []) {
  const merged = new Map();
  if (Array.isArray(currentItems)) {
    currentItems.forEach((item) => {
      if (item?.id) merged.set(item.id, item);
    });
  }
  if (Array.isArray(incomingItems)) {
    incomingItems.forEach((item) => {
      if (item?.id) merged.set(item.id, item);
    });
  }
  return Array.from(merged.values());
}

function mergeDeletedIds(currentIds = [], incomingIds = []) {
  return Array.from(new Set([...(Array.isArray(currentIds) ? currentIds : []), ...(Array.isArray(incomingIds) ? incomingIds : [])]));
}

function getMarshalStore(name) {
  const siteID =
    process.env.MARSHAL_NETLIFY_SITE_ID ||
    process.env.NETLIFY_SITE_ID ||
    process.env.SITE_ID;

  const token =
    process.env.MARSHAL_NETLIFY_TOKEN ||
    process.env.NETLIFY_BLOBS_TOKEN ||
    process.env.NETLIFY_AUTH_TOKEN;

  if (siteID && token) {
    return getStore(name, { siteID, token });
  }

  return getStore(name);
}

async function getAuthenticatedUser(store, authHeader) {
  const token = readBearerToken(authHeader);
  if (!token) return null;

  const session = await store.get(`session:${token}`, { type: "json" });
  if (!session || new Date(session.expiresAt) < new Date()) {
    await store.delete(`session:${token}`).catch(() => {});
    return null;
  }

  const users = (await store.get("users", { type: "json" })) || [];
  const user = users.find((item) => item.id === session.userId);
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
  };
}

function readBearerToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length).trim();
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers });
}
