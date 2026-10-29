// =============================================================
// OnChat 알림 서버 (Cloudflare Worker)
// 앱이 꺼져 있어도 새 메시지 알림이 가게 해 줌 (웹 푸시)
//
// 필요한 설정: KV 이름공간을 "SUBS" 라는 이름으로 연결
// 비밀 키(VAPID)는 처음 실행될 때 서버가 스스로 만들어서 KV에 저장함
// =============================================================

const PROJECT_ID = "onchat-fc78e";
const FIRESTORE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const CONTACT = "mailto:onchat@example.com"; // 푸시 서비스에 알려주는 연락처 (형식만 맞으면 됨)
const RTDB = "https://onchat-fc78e-default-rtdb.asia-southeast1.firebasedatabase.app";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);
    try {
      if (url.pathname === "/vapid" && request.method === "GET") {
        const keys = await getVapid(env);
        return text(keys.publicKey);
      }
      if (url.pathname === "/" && request.method === "GET") {
        return text("OnChat 알림 서버가 켜져 있어요 ✅");
      }
      if (request.method !== "POST") return text("없는 주소예요", 404);

      const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const body = await request.json().catch(() => ({}));
      const me = await whoAmI(token); // 로그인한 사람 확인 (Firebase가 직접 확인해 줌)
      if (!me) return text("로그인이 필요해요", 401);

      if (url.pathname === "/subscribe") return await subscribe(env, me, body);
      if (url.pathname === "/unsubscribe") return await unsubscribe(env, me, body);
      if (url.pathname === "/notify") return await notify(env, me, token, body, request);
      if (url.pathname === "/ice") return await ice(env);
      return text("없는 주소예요", 404);
    } catch (err) {
      return text("서버 오류: " + (err && err.message), 500);
    }
  },
};

function text(s, status = 200) {
  return new Response(s, { status, headers: { ...CORS, "Content-Type": "text/plain; charset=utf-8" } });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

/* ---------------- 로그인 확인 ---------------- */
// 토큰 안의 uid로 accounts/{uid} 를 "그 사람 토큰으로" 읽어 봄
// → Firebase가 토큰이 진짜인지, 보안 규칙상 본인인지 확인해 줌
async function whoAmI(token) {
  if (!token) return null;
  let uid;
  try {
    uid = JSON.parse(new TextDecoder().decode(b64urlDecode(token.split(".")[1]))).user_id;
  } catch (e) {
    return null;
  }
  if (!uid) return null;
  const doc = await fsGet(`accounts/${uid}`, token);
  const phone = doc && str(doc.fields && doc.fields.phone);
  return phone ? { uid, phone } : null;
}

async function fsGet(path, token) {
  const res = await fetch(`${FIRESTORE}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  return res.json();
}
function str(v) {
  return v && typeof v.stringValue === "string" ? v.stringValue : "";
}

/* ---------------- 구독 저장 / 삭제 ---------------- */
const MAX_DEVICES = 10;

async function readSubs(env, phone) {
  return (await env.SUBS.get("subs:" + phone, "json")) || [];
}

async function subscribe(env, me, body) {
  const sub = body && body.subscription;
  if (!sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return text("구독 정보가 이상해요", 400);
  }
  const clean = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
  const list = (await readSubs(env, me.phone)).filter((s) => s.endpoint !== clean.endpoint);
  list.push(clean);
  await env.SUBS.put("subs:" + me.phone, JSON.stringify(list.slice(-MAX_DEVICES)));
  return json({ ok: true, devices: Math.min(list.length, MAX_DEVICES) });
}

async function unsubscribe(env, me, body) {
  const endpoint = body && body.endpoint;
  const list = await readSubs(env, me.phone);
  const next = list.filter((s) => s.endpoint !== endpoint);
  if (next.length !== list.length) await env.SUBS.put("subs:" + me.phone, JSON.stringify(next));
  return json({ ok: true });
}

/* ---------------- 알림 보내기 ---------------- */
async function notify(env, me, token, body, request) {
  const roomId = body && typeof body.roomId === "string" ? body.roomId : "";
  if (!roomId || roomId.includes("/")) return text("방 번호가 이상해요", 400);

  // 보낸 사람 토큰으로 방을 읽음 → 멤버가 아니면 Firebase가 거절
  const room = await fsGet(`rooms/${roomId}`, token);
  if (!room || !room.fields) return text("방을 읽을 수 없어요", 403);
  const f = room.fields;
  const members = ((f.members && f.members.arrayValue && f.members.arrayValue.values) || []).map(str).filter(Boolean);
  if (!members.includes(me.phone)) return text("이 방 멤버가 아니에요", 403);

  const isGroup = str(f.type) === "group";
  const preview = (str(f.lastMessage) || "새 메시지").slice(0, 120);
  const senderDoc = await fsGet(`users/${me.phone}`, token);
  const nick = (senderDoc && str(senderDoc.fields && senderDoc.fields.nickname)) || "친구";
  const roomName = str(f.name) || "단톡방";
  const isCall = body.kind === "call";
  const title = isCall ? nick : isGroup ? roomName : nick;
  const msgText = isCall ? `📞 ${nick}님이 톡챗을 걸었어요` : isGroup ? `${nick}: ${preview}` : preview;
  // 알림 누르면 열 주소 (앱이 알려준 주소, https만)
  let appUrl = typeof body.appUrl === "string" && /^https:\/\/[^\s]+$/.test(body.appUrl) ? body.appUrl.split("?")[0] : "";
  if (!appUrl) appUrl = (request.headers.get("Origin") || "https://github.io") + "/";
  const navigate = appUrl + "?room=" + encodeURIComponent(roomId);
  const payload = JSON.stringify({ title, body: msgText, roomId, navigate });
  // 지금 앱 화면을 보고 있는 사람은 빼기 (앱 안에서 바로 보니까)
  const skip = new Set(Array.isArray(body.skip) ? body.skip.filter((p) => typeof p === "string") : []);

  const vapid = await getVapid(env);
  let sent = 0;
  for (const phone of members) {
    if (phone === me.phone || skip.has(phone)) continue;
    const list = await readSubs(env, phone);
    if (!list.length) continue;
    if (!isCall && (await isWatching(phone, token))) continue; // 앱 화면을 보고 있으면 안 보냄
    const alive = [];
    for (const sub of list) {
      const status = await sendPush(sub, payload, vapid).catch(() => 0);
      if (status === 404 || status === 410) continue; // 앱 지웠거나 알림 끈 기기 → 정리
      alive.push(sub);
      if (status >= 200 && status < 300) sent++;
    }
    if (alive.length !== list.length) await env.SUBS.put("subs:" + phone, JSON.stringify(alive));
  }
  return json({ ok: true, sent });
}

// 받는 사람이 지금 온챗 화면을 보고 있나? (접속 정보에서 1 = 보는 중)
async function isWatching(phone, token) {
  try {
    const u = await fsGet(`users/${phone}`, token);
    const uid = u && str(u.fields && u.fields.uid);
    if (!uid) return false;
    const res = await fetch(`${RTDB}/presence/${encodeURIComponent(uid)}/conns.json?auth=${encodeURIComponent(token)}`);
    if (!res.ok) return false;
    const conns = await res.json();
    return !!conns && Object.values(conns).some((v) => v === 1);
  } catch (e) {
    return false;
  }
}

/* ---------------- 톡챗 연결 도우미 (TURN) ---------------- */
// Cloudflare Realtime TURN 키를 설정해 두면(TURN_KEY_ID, TURN_KEY_TOKEN) 중계 서버 정보를 만들어 줌
// 설정 안 했으면 무료 STUN 만 (대부분 와이파이에선 이걸로 충분)
async function ice(env) {
  const stun = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_TOKEN) return json({ iceServers: stun });
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TURN_KEY_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: 86400 }),
    });
    if (!res.ok) return json({ iceServers: stun });
    const j = await res.json();
    return json({ iceServers: j.iceServers || stun });
  } catch (e) {
    return json({ iceServers: stun });
  }
}

/* ---------------- VAPID 키 (처음 한 번 자동 생성) ---------------- */
async function getVapid(env) {
  const saved = await env.SUBS.get("vapid", "json");
  if (saved) return saved;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const rawPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const keys = { publicKey: b64urlEncode(rawPublic), privateJwk };
  await env.SUBS.put("vapid", JSON.stringify(keys));
  return keys;
}

async function vapidHeader(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const header = b64urlEncode(enc('{"typ":"JWT","alg":"ES256"}'));
  const claims = b64urlEncode(enc(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: CONTACT })));
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64urlEncode(sig)}, k=${vapid.publicKey}`;
}

/* ---------------- 웹 푸시 암호화 (RFC 8291, aes128gcm) ---------------- */
async function encryptPayload(sub, plaintext) {
  const uaPublic = b64urlDecode(sub.keys.p256dh); // 받는 기기 공개키 (65바이트)
  const authSecret = b64urlDecode(sub.keys.auth); // 받는 기기 비밀값 (16바이트)

  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const keyInfo = concat(enc("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const padded = concat(enc(plaintext), new Uint8Array([2])); // 마지막 조각 표시
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

async function sendPush(sub, payload, vapid) {
  const body = await encryptPayload(sub, payload);
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(sub.endpoint, vapid),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
    },
    body,
  });
  return res.status;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/* ---------------- 작은 도우미 ---------------- */
function enc(s) {
  return new TextEncoder().encode(s);
}
function concat(...arrays) {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let i = 0;
  for (const a of arrays) {
    out.set(a, i);
    i += a.length;
  }
  return out;
}
function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
