// Service Worker: ①オフラインでも開けるよう画面部品を保存 ②他のアプリ(OneDriveなど)から「共有」されたJWWを受け取る。
const CACHE = "jww-reading-v3";
const SHARED_CACHE = "jww-reading-shared";
const SHARE_PATH = "./share-target";
const SHARED_KEY = new URL("./__shared__", self.registration.scope).href;
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/app.css",
  "./js/app.js",
  "./js/aci.js",
  "./js/drawing.js",
  "./js/viewer.js",
  "./vendor/ezjww.mjs",
  "./vendor/ezjww_wasm_bg.wasm",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== SHARED_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method === "POST" && url.href === new URL(SHARE_PATH, self.registration.scope).href) {
    event.respondWith(receiveShared(request));
    return;
  }
  if (request.method !== "GET" || url.origin !== location.origin) return;
  // 通信できるときは最新を取り、できないときは保存したものを使う
  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(request, copy));
        }
        return res;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }))
  );
});

/** 共有されたファイルを一時保存し、画面側が取り出せるようにしてから、アプリの画面へ移動する。 */
async function receiveShared(request) {
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (file && typeof file !== "string") {
      const cache = await caches.open(SHARED_CACHE);
      await cache.put(
        SHARED_KEY,
        new Response(file, { headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name) } })
      );
    }
  } catch (err) {
    // 受け取りに失敗しても、画面は開く(画面側で「開けませんでした」と案内する)
  }
  return Response.redirect(new URL("./?shared=1", self.registration.scope).href, 303);
}
