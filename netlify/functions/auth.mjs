import crypto from "node:crypto";
import { getStore } from "@netlify/blobs";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

const sessionDays = 30;

export default async function handler(request) {
  try {
    if (request.method === "OPTIONS") {
      return new Response("", { status: 204, headers });
    }

    const store = getMarshalStore("marshal-auth");
    const url = new URL(request.url);

    if (request.method === "GET") {
      const inviteToken = url.searchParams.get("invite");
      if (inviteToken) {
        return getInvite(store, inviteToken);
      }

      const users = await getUsers(store);
      const invites = await getInvites(store);
      const user = await getAuthenticatedUser(store, request.headers.get("authorization"));

      return json(200, {
        user,
        setupRequired: users.length === 0,
        users: user?.role === "admin" ? publicUsers(users) : [],
        invites: user?.role === "admin" ? publicInvites(invites) : [],
      });
    }

    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const body = await request.json().catch(() => ({}));
    const action = body.action;
    const dataStore = getMarshalStore("marshal");

    if (action === "setup") {
      return setupOwner(store, body);
    }

    if (action === "login") {
      return login(store, body);
    }

    if (action === "accept-invite") {
      return acceptInvite(store, dataStore, body);
    }

    if (action === "logout") {
      const token = readBearerToken(request.headers.get("authorization"));
      if (token) await store.delete(`session:${token}`);
      return json(200, { ok: true });
    }

    const currentUser = await getAuthenticatedUser(store, request.headers.get("authorization"));
    if (!currentUser) {
      return json(403, { error: "Sign in required" });
    }

    if (action === "change-password") {
      return changePassword(store, body, currentUser);
    }

    if (currentUser.role !== "admin") {
      return json(403, { error: "Admin access required" });
    }

    if (action === "create-user") {
      return createUser(store, body);
    }

    if (action === "create-invite") {
      return createInvite(store, body, currentUser);
    }

    if (action === "delete-user") {
      return deleteUser(store, body, currentUser);
    }

    if (action === "delete-invite") {
      return deleteInvite(store, body);
    }

    if (action === "reset-password") {
      return resetPassword(store, body);
    }

    return json(400, { error: "Unknown action" });
  } catch (error) {
    console.error(error);
    return json(500, {
      error: "Auth function failed",
      detail: error.message,
      name: error.name,
    });
  }
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

async function setupOwner(store, body) {
  const users = await getUsers(store);
  if (users.length) return json(409, { error: "Owner account already exists" });

  const user = makeUser(body, "admin");
  user.password = hashPassword(assertPassword(body.password));
  await setUsers(store, [user]);
  const token = await createSession(store, user.id);

  return json(200, { token, user: publicUser(user), users: [publicUser(user)] });
}

async function login(store, body) {
  const users = await getUsers(store);
  const email = normalizeEmail(body.email);
  const user = users.find((item) => item.email === email);

  if (!user || !verifyPassword(body.password || "", user.password)) {
    return json(401, { error: "Invalid email or password" });
  }

  const token = await createSession(store, user.id);
  return json(200, { token, user: publicUser(user), users: user.role === "admin" ? publicUsers(users) : [] });
}

async function createUser(store, body) {
  const users = await getUsers(store);
  const email = normalizeEmail(body.email);

  if (users.some((user) => user.email === email)) {
    return json(409, { error: "Email is already in use" });
  }

  const user = makeUser(body, body.role === "admin" ? "admin" : "employee");
  user.password = hashPassword(assertPassword(body.password));
  users.push(user);
  await setUsers(store, users);

  return json(200, { user: publicUser(user), users: publicUsers(users) });
}

async function createInvite(store, body, currentUser) {
  const users = await getUsers(store);
  const invites = await getInvites(store);
  const email = normalizeEmail(body.email);
  const name = String(body.name || "").trim();

  if (!name) throw new Error("Name is required");
  if (!email.includes("@")) throw new Error("Valid email is required");
  if (users.some((user) => user.email === email)) {
    return json(409, { error: "A login account already exists for this email" });
  }

  const pendingInvite = invites.find((invite) => invite.email === email && !invite.acceptedAt);
  if (pendingInvite) return json(200, { invite: publicInvite(pendingInvite), invites: publicInvites(invites) });

  const invite = {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(24).toString("hex"),
    name,
    email,
    phone: String(body.phone || "").trim(),
    role: body.role === "admin" ? "admin" : "employee",
    createdAt: new Date().toISOString(),
    createdBy: currentUser.id,
    acceptedAt: null,
    acceptedUserId: null,
  };

  invites.unshift(invite);
  await setInvites(store, invites);
  return json(200, { invite: publicInvite(invite), invites: publicInvites(invites) });
}

async function getInvite(store, token) {
  const invites = await getInvites(store);
  const invite = invites.find((item) => item.token === token);
  if (!invite) return json(404, { error: "Invite link not found" });

  return json(200, {
    invite: {
      name: invite.name,
      email: invite.email,
      phone: invite.phone || "",
      role: invite.role,
      acceptedAt: invite.acceptedAt,
    },
  });
}

async function acceptInvite(store, dataStore, body) {
  const invites = await getInvites(store);
  const invite = invites.find((item) => item.token === body.token);
  if (!invite) return json(404, { error: "Invite link not found" });
  if (invite.acceptedAt) return json(409, { error: "Invite has already been used" });

  const users = await getUsers(store);
  const email = normalizeEmail(body.email || invite.email);
  if (email !== invite.email) return json(400, { error: "Use the email address from the invite" });
  if (users.some((user) => user.email === email)) {
    return json(409, { error: "A login account already exists for this email" });
  }

  const user = makeUser(
    {
      name: body.name || invite.name,
      email,
      password: body.password,
    },
    invite.role,
  );
  user.password = hashPassword(assertPassword(body.password));
  users.push(user);
  invite.acceptedAt = new Date().toISOString();
  invite.acceptedUserId = user.id;

  await setUsers(store, users);
  await setInvites(store, invites);
  await upsertEmployeeFromInvite(dataStore, invite, body);

  const sessionToken = await createSession(store, user.id);
  return json(200, { token: sessionToken, user: publicUser(user), users: [], invites: [] });
}

async function upsertEmployeeFromInvite(store, invite, body) {
  const data = (await store.get("shared-data", { type: "json" })) || {};
  const employees = Array.isArray(data.employees) ? data.employees : [];
  const email = normalizeEmail(invite.email);
  const existingIndex = employees.findIndex((employee) => normalizeEmail(employee.email) === email);
  const existing = existingIndex >= 0 ? employees[existingIndex] : {};
  const name = String(body.name || invite.name || "").trim();
  const employee = {
    ...existing,
    id: existing.id || crypto.randomUUID(),
    name,
    initials: normalizeInitials(body.initials, name),
    role: existing.role || "Team member",
    email,
    phone: String(body.phone || existing.phone || "").trim(),
    nextOfKinName: String(body.nextOfKinName || existing.nextOfKinName || "").trim(),
    nextOfKinPhone: String(body.nextOfKinPhone || existing.nextOfKinPhone || "").trim(),
    color: existing.color || colorForText(email),
    status: existing.status || "Available",
  };

  if (existingIndex >= 0) {
    employees[existingIndex] = employee;
  } else {
    employees.push(employee);
  }

  const nextData = {
    businessName: !data.businessName || data.businessName === "Marshal" ? "Sherif" : data.businessName,
    businessSubtitle: data.businessSubtitle || "Rock N Water Landscapes",
    appInstalled: Boolean(data.appInstalled),
    notificationsEnabled: Boolean(data.notificationsEnabled),
    currentUserId: data.currentUserId || employee.id,
    activeChannel: "team",
    areas: Array.isArray(data.areas) && data.areas.length ? data.areas : ["General", "Landscaping", "Maintenance", "Construction", "Admin"],
    employees,
    channels: [{ id: "team", name: "Team", description: "Company messages and daily updates" }],
    shifts: Array.isArray(data.shifts) ? data.shifts : [],
    messages: Array.isArray(data.messages) ? data.messages : [],
    requests: Array.isArray(data.requests) ? data.requests : [],
    savedAt: new Date().toISOString(),
  };

  await store.setJSON("shared-data", nextData);
}

function normalizeInitials(initials, name) {
  const value = String(initials || "").trim().toUpperCase();
  if (value) return value.slice(0, 3);
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

async function deleteUser(store, body, currentUser) {
  const users = await getUsers(store);
  const userId = body.userId;
  if (!userId) return json(400, { error: "Missing user id" });
  if (userId === currentUser.id) return json(400, { error: "You cannot delete your own account" });

  const remainingUsers = users.filter((user) => user.id !== userId);
  await setUsers(store, remainingUsers);
  return json(200, { users: publicUsers(remainingUsers) });
}

async function deleteInvite(store, body) {
  const invites = await getInvites(store);
  const inviteId = body.inviteId;
  if (!inviteId) return json(400, { error: "Missing invite id" });

  const remainingInvites = invites.filter((invite) => invite.id !== inviteId);
  await setInvites(store, remainingInvites);
  return json(200, { invites: publicInvites(remainingInvites) });
}

async function changePassword(store, body, currentUser) {
  const users = await getUsers(store);
  const user = users.find((item) => item.id === currentUser.id);
  if (!user) return json(404, { error: "User not found" });

  if (!verifyPassword(body.currentPassword || "", user.password)) {
    return json(401, { error: "Current password is incorrect" });
  }

  user.password = hashPassword(assertPassword(body.newPassword));
  await setUsers(store, users);
  return json(200, { ok: true });
}

async function resetPassword(store, body) {
  const users = await getUsers(store);
  const user = users.find((item) => item.id === body.userId);
  if (!user) return json(404, { error: "User not found" });

  user.password = hashPassword(assertPassword(body.newPassword));
  await setUsers(store, users);
  return json(200, { users: publicUsers(users) });
}

async function createSession(store, userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000).toISOString();
  await store.setJSON(`session:${token}`, { userId, expiresAt });
  return token;
}

async function getAuthenticatedUser(store, authHeader) {
  const token = readBearerToken(authHeader);
  if (!token) return null;

  const session = await store.get(`session:${token}`, { type: "json" });
  if (!session || new Date(session.expiresAt) < new Date()) {
    await store.delete(`session:${token}`).catch(() => {});
    return null;
  }

  const users = await getUsers(store);
  const user = users.find((item) => item.id === session.userId);
  return user ? publicUser(user) : null;
}

function readBearerToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length).trim();
}

async function getUsers(store) {
  return (await store.get("users", { type: "json" })) || [];
}

async function setUsers(store, users) {
  await store.setJSON("users", users);
}

async function getInvites(store) {
  return (await store.get("invites", { type: "json" })) || [];
}

async function setInvites(store, invites) {
  await store.setJSON("invites", invites);
}

function makeUser(body, role) {
  const name = String(body.name || "").trim();
  const email = normalizeEmail(body.email);

  if (!name) throw new Error("Name is required");
  if (!email.includes("@")) throw new Error("Valid email is required");

  return {
    id: crypto.randomUUID(),
    name,
    email,
    role,
    createdAt: new Date().toISOString(),
  };
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function assertPassword(password) {
  const value = String(password || "");
  if (value.length < 8) throw new Error("Password must be at least 8 characters");
  return value;
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedPassword) {
  const [salt, storedHash] = String(storedPassword || "").split(":");
  if (!salt || !storedHash) return false;

  const candidate = crypto.scryptSync(password, salt, 64);
  const stored = Buffer.from(storedHash, "hex");
  return stored.length === candidate.length && crypto.timingSafeEqual(stored, candidate);
}

function publicUsers(users) {
  return users.map(publicUser);
}

function publicInvites(invites) {
  return invites.map(publicInvite);
}

function publicInvite(invite) {
  return {
    id: invite.id,
    token: invite.token,
    name: invite.name,
    email: invite.email,
    phone: invite.phone || "",
    role: invite.role,
    createdAt: invite.createdAt,
    acceptedAt: invite.acceptedAt,
  };
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers });
}
