// OnChat 서비스 워커: 홈 화면 앱으로 열리게 하고, 알림을 누르면 그 채팅방을 열어 줌
const CACHE = "onchat-v5"; // 알림마다 새로 울리게
const SHELL = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 온챗 파일만: 인터넷 되면 최신 걸 받고, 안 되면 저장해 둔 걸로 열기
// (Firebase 같은 바깥 주소는 건드리지 않음)
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("./index.html")))
  );
});

// 앱이 꺼져 있을 때 서버에서 온 새 메시지 알림 띄우기
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch (err) {
    data = { body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    (async () => {
      // 온챗을 보고 있는 중이면 앱 안 배너가 뜨니까 안 띄움 (아이폰은 꼭 띄워야 해서 예외)
      const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const watching = list.some((c) => c.visibilityState === "visible" && c.focused);
      const ios = /iPhone|iPad|iPod/.test(self.navigator.userAgent);
      if (watching && !ios) return;
      await self.registration.showNotification(data.title || "OnChat", {
        body: data.body || "새 메시지가 왔어요",
        // 아이폰은 같은 tag면 조용히 바꿔치기만 해서 소리가 안 남 → 알림마다 다른 tag
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

// 알림 누르면: 열린 온챗 창이 있으면 그 창에서 방 열기, 없으면 새로 열기
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
