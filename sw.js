// OnChat 서비스 워커: 홈 화면 앱으로 열리게 하고, 알림을 누르면 그 채팅방을 열어 줌
const CACHE = "onchat-v8"; // 빨리 열리게
const LIB = "onchat-lib-13.1.0"; // Firebase 프로그램 (버전이 주소에 있어서 안 바뀜)
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== LIB && k !== "onchat-badge").map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.href.startsWith("https://www.gstatic.com/firebasejs/13.1.0/")) {
    e.respondWith(
      caches.open(LIB).then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      })
    );
    return;
  }
  if (url.origin !== location.origin) return;
  e.respondWith(
    (async () => {
      const net = fetch(e.request).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      });
      const cached = await caches.match(e.request);
      if (!cached) return net.catch(() => caches.match("./index.html"));
      const slow = new Promise((r) => setTimeout(() => r(cached), 3000));
      return Promise.race([net.catch(() => cached), slow]);
    })()
  );
});

self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch (err) {
    data = { body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const watching = list.some((c) => c.visibilityState === "visible" && c.focused);
      const ios = /iPhone|iPad|iPod/.test(self.navigator.userAgent);
      if (watching && !ios) return;
      if (ios && data.web_push === 8030 && e.notification) return;
      // 홈 화면 아이콘 숫자 +1 (앱을 열면 정확한 숫자로 다시 맞춰요)
      try {
        const bc = await caches.open("onchat-badge");
        const old = await bc.match("/badge");
        const n = (old ? parseInt(await old.text(), 10) || 0 : 0) + 1;
        await bc.put("/badge", new Response(String(n)));
        if (self.navigator.setAppBadge) await self.navigator.setAppBadge(n);
      } catch (err) { /* 지원 안 하는 기기 */ }
      await self.registration.showNotification(data.title || "OnChat", {
        body: data.body || "새 메시지가 왔어요",
        tag: (data.roomId || "onchat") + "-" + Date.now(),
        renotify: true,
        silent: false,
        vibrate: [200, 100, 200],
        timestamp: Date.now(),
        icon: "icon-192.png",
        badge: "icon-192.png",
        data: { roomId: data.roomId },
      });
    })()
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const roomId = e.notification.data && e.notification.data.roomId;
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.postMessage({ type: "open-room", roomId });
          return c.focus();
        }
      }
      return self.clients.openWindow("./" + (roomId ? "?room=" + encodeURIComponent(roomId) : ""));
    })
  );
});
