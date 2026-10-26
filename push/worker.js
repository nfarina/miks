// Miks's push relay, at https://miks-push.nfarina.com. The APNs key stays
// here, as a secret: a daemon runs on anyone's Mac and the app's bundle is
// public, so neither can hold it. A device registers its token and gets back
// an opaque id (the token and its APNs environment, sealed with ID_SECRET),
// which is all a daemon ever has; a daemon sends to that id.
//
//   POST /register {token, environment}  → {id}
//   POST /send {id, alert: {title, subtitle?, body, thread, mac, tabId}} → {ok} | {gone}
//   POST /send {id, clear: [thread, …]}  → {ok} | {gone}
//
// `gone` means the device won't take pushes any more (the app was deleted,
// or the token is from another build): forget it.

/** The iOS app (com.nfarina.miks.ios), whatever key signs for it. */
const TOPIC = "com.nfarina.miks.ios";

/** By the app's aps-environment: development builds (Xcode, ios/share.sh) get the sandbox's. */
const HOSTS = { production: "api.push.apple.com", development: "api.sandbox.push.apple.com" };

/** APNs takes a provider token for up to an hour, and refuses new ones more often than every 20 minutes. */
const TOKEN_LIFETIME = 40 * 60 * 1000;

export default {
  async fetch(request, env) {
    if (request.method !== "POST") return json({ error: "POST only." }, 405);
    const { pathname } = new URL(request.url);
    const body = await request.json().catch(() => null);
    if (!body) return json({ error: "Not JSON." }, 400);

    if (pathname === "/register") {
      const { token, environment } = body;
      if (typeof token !== "string" || !/^[0-9a-f]{32,400}$/i.test(token) || !HOSTS[environment]) {
        return json({ error: "A device token and its environment, please." }, 400);
      }
      return json({ id: await seal(env, { token, environment }) });
    }

    if (pathname === "/send") {
      const device = await unseal(env, body.id).catch(() => null);
      if (!device) return json({ gone: true });
      const push = Array.isArray(body.clear) ? clearPush(body.clear) : body.alert ? alertPush(body.alert) : null;
      if (!push) return json({ error: "An alert or threads to clear, please." }, 400);

      const response = await fetch(`https://${HOSTS[device.environment]}/3/device/${device.token}`, {
        method: "POST",
        headers: { authorization: `bearer ${await providerToken(env)}`, "apns-topic": TOPIC, ...push.headers },
        body: JSON.stringify(push.payload),
      });
      if (response.ok) return json({ ok: true });
      const reason = (await response.json().catch(() => null))?.reason;
      if (response.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered")
        return json({ gone: true });
      return json({ error: reason ?? `APNs answered ${response.status}.` }, 502);
    }

    return json({ error: "Not found." }, 404);
  },
};

/** A notification for a tab: one per tab (`apns-collapse-id`), in its thread, so seeing it anywhere clears it. */
function alertPush({ title, subtitle, body, thread, mac, tabId }) {
  if (typeof thread !== "string" || !thread) return null;
  const text = (value, limit) => (typeof value === "string" ? value.slice(0, limit) : undefined);
  return {
    headers: { "apns-push-type": "alert", "apns-priority": "10", "apns-collapse-id": thread.slice(0, 64) },
    payload: {
      aps: {
        alert: { title: text(title, 200), subtitle: text(subtitle, 200), body: text(body, 1000) },
        sound: "default",
        "thread-id": thread,
      },
      mac: text(mac, 300),
      tabId: text(tabId, 100),
    },
  };
}

/** Wakes the app to take those threads' notifications away (ios/Shared/AppNotifications.swift). */
function clearPush(threads) {
  const names = threads.filter((thread) => typeof thread === "string" && thread && !thread.includes(","));
  if (names.length === 0) return null;
  return {
    headers: { "apns-push-type": "background", "apns-priority": "5" },
    payload: { aps: { "content-available": 1 }, clear_threads: names.join(",") },
  };
}

let cachedToken = null;

/** The JWT APNs wants, signed with the key (ES256), reused while it's fresh. */
async function providerToken(env) {
  if (cachedToken && Date.now() - cachedToken.at < TOKEN_LIFETIME) return cachedToken.token;
  const der = Uint8Array.from(atob(env.APNS_KEY.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const unsigned = `${base64url({ alg: "ES256", kid: env.APNS_KEY_ID })}.${base64url({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsigned),
  );
  cachedToken = { token: `${unsigned}.${base64url(new Uint8Array(signature))}`, at: Date.now() };
  return cachedToken.token;
}

async function idKey(env) {
  const raw = Uint8Array.from(atob(env.ID_SECRET), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await idKey(env),
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return base64url(new Uint8Array([...iv, ...new Uint8Array(sealed)]));
}

async function unseal(env, id) {
  const bytes = Uint8Array.from(atob(id.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const opened = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(0, 12) },
    await idKey(env),
    bytes.slice(12),
  );
  const value = JSON.parse(new TextDecoder().decode(opened));
  if (typeof value?.token !== "string" || !HOSTS[value.environment]) throw new Error("Not a device.");
  return value;
}

/** Bytes, or anything else as JSON, in base64url. */
function base64url(value) {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(JSON.stringify(value));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// Any origin: the app's page registers from crosswing://app, and an id is
// no use to anyone without a token of its own to have sealed.
function json(value, status = 200) {
  return Response.json(value, { status, headers: { "access-control-allow-origin": "*" } });
}
