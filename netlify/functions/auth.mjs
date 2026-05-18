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

    if (request.method === "GET") {
      const users = await getUsers(store);
      const user = await getAuthenticatedUser(store, request.headers.get("authorization"));

      return json(200, {
        user,
        setupRequired: users.length === 0,
        users: user?.role === "admin" ? publicUsers(users) : [],
      });
    }

    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const body = await request.json().catch(() => ({}));
    const action = body.action;

    if (action === "setup") {
      return setupOwner(store, body);
    }

    if (action === "login") {
      return login(store, body);
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

    if (action === "delete-user") {
      return deleteUser(store, body, currentUser);
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

async function deleteUser(store, body, currentUser) {
  const users = await getUsers(store);
  const userId = body.userId;
  if (!userId) return json(400, { error: "Missing user id" });
  if (userId === currentUser.id) return json(400, { error: "You cannot delete your own account" });

  const remainingUsers = users.filter((user) => user.id !== userId);
  await setUsers(store, remainingUsers);
  return json(200, { users: publicUsers(remainingUsers) });
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
