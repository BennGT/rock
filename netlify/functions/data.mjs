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
      return json(200, { data: data || null });
    }

    if (request.method === "POST") {
      const payload = await request.json().catch(() => ({}));
      const data = payload.data || payload;

      if (!data || typeof data !== "object" || Array.isArray(data)) {
        return json(400, { error: "Invalid data payload" });
      }

      const currentData = (await store.get("shared-data", { type: "json" })) || {};
      const nextData = user.role === "admin" ? mergeAdminData(currentData, data) : mergeEmployeeData(currentData, data, user);

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
  return {
    ...incomingData,
    messages: mergeById(currentData.messages, incomingData.messages),
    requests: mergeById(currentData.requests, incomingData.requests),
  };
}

function mergeEmployeeData(currentData, incomingData, user) {
  const employeeId = findEmployeeIdForUser(currentData, user);
  if (!employeeId) return currentData;

  const currentMessages = Array.isArray(currentData.messages) ? currentData.messages : [];
  const incomingMessages = Array.isArray(incomingData.messages) ? incomingData.messages : [];
  const currentMessageIds = new Set(currentMessages.map((message) => message.id));
  const newOwnMessages = incomingMessages.filter(
    (message) => message.employeeId === employeeId && message.id && !currentMessageIds.has(message.id),
  );

  const currentRequests = Array.isArray(currentData.requests) ? currentData.requests : [];
  const incomingRequests = Array.isArray(incomingData.requests) ? incomingData.requests : [];
  const otherRequests = currentRequests.filter((request) => request.employeeId !== employeeId);
  const ownRequests = incomingRequests
    .filter((request) => request.employeeId === employeeId && request.id)
    .map((request) => {
      const existing = currentRequests.find((item) => item.id === request.id);
      return {
        ...request,
        status: existing?.status || request.status || "Pending",
      };
    });

  return {
    ...currentData,
    messages: [...currentMessages, ...newOwnMessages],
    requests: [...ownRequests, ...otherRequests],
    savedAt: incomingData.savedAt || currentData.savedAt,
  };
}

function findEmployeeIdForUser(data, user) {
  const employees = Array.isArray(data.employees) ? data.employees : [];
  return employees.find((employee) => normalizeEmail(employee.email) === normalizeEmail(user.email))?.id || null;
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
