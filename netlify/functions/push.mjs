import { getStore } from "@netlify/blobs";
import webpush from "web-push";

const headers = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

export default async function handler(request) {
  try {
    if (request.method === "OPTIONS") {
      return new Response("", { status: 204, headers });
    }

    const publicKey = process.env.MARSHAL_VAPID_PUBLIC_KEY || "";
    const privateKey = process.env.MARSHAL_VAPID_PRIVATE_KEY || "";
    const subject = process.env.MARSHAL_VAPID_SUBJECT || "mailto:admin@example.com";

    if (request.method === "GET") {
      return json(200, { enabled: Boolean(publicKey && privateKey), publicKey });
    }

    if (request.method !== "POST") {
      return json(405, { error: "Method not allowed" });
    }

    const authStore = getMarshalStore("marshal-auth");
    const user = await getAuthenticatedUser(authStore, request.headers.get("authorization"));
    if (!user) return json(401, { error: "Sign in required" });

    const body = await request.json().catch(() => ({}));
    const store = getMarshalStore("marshal-push");

    if (body.action === "subscribe") {
      if (!body.subscription?.endpoint) return json(400, { error: "Missing push subscription" });
      const subscriptions = await getSubscriptions(store);
      const next = subscriptions.filter((item) => item.subscription?.endpoint !== body.subscription.endpoint);
      next.push({
        userId: user.id,
        userEmail: user.email,
        employeeId: body.employeeId || null,
        subscription: body.subscription,
        createdAt: new Date().toISOString(),
      });
      await setSubscriptions(store, next);
      return json(200, { ok: true });
    }

    if (body.action === "notify") {
      if (!publicKey || !privateKey) return json(400, { error: "Push notifications are not configured" });

      webpush.setVapidDetails(subject, publicKey, privateKey);
      const subscriptions = await getSubscriptions(store);
      const message = JSON.stringify({
        title: String(body.title || "Sherif"),
        body: String(body.body || ""),
        url: String(body.url || "/"),
      });
      const excludeUserId = body.excludeUserId ? String(body.excludeUserId) : "";

      const validSubscriptions = [];
      let sent = 0;

      await Promise.all(
        subscriptions.map(async (item) => {
          if (excludeUserId && item.userId === excludeUserId) {
            validSubscriptions.push(item);
            return;
          }
          try {
            await webpush.sendNotification(item.subscription, message);
            validSubscriptions.push(item);
            sent += 1;
          } catch (error) {
            if (![404, 410].includes(error.statusCode)) validSubscriptions.push(item);
          }
        }),
      );

      if (validSubscriptions.length !== subscriptions.length) {
        await setSubscriptions(store, validSubscriptions);
      }

      return json(200, { ok: true, sent });
    }

    return json(400, { error: "Unknown action" });
  } catch (error) {
    console.error(error);
    return json(500, {
      error: "Push function failed",
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

async function getSubscriptions(store) {
  return (await store.get("subscriptions", { type: "json" })) || [];
}

async function setSubscriptions(store, subscriptions) {
  await store.setJSON("subscriptions", subscriptions);
}

function readBearerToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.slice("Bearer ".length).trim();
}

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers });
}
