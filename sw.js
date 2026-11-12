// 离线缓存：
//  - 页面、脚本、词库 JSON：联网时总是取最新的，断网时用缓存
//  - mp3 音频：内容不会变（文件名就是文本哈希），缓存优先，听过一次就能离线播放
const CACHE = 'french-v3'; // 改版本号会清掉旧缓存（比如音频重新生成后）
const SHELL = ['./', 'index.html', 'app.js', 'manifest.json',
               'words.json', 'verbs.json', 'sentences.json',
               'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', function(e) {
    e.waitUntil(caches.open(CACHE).then(function(c) { return c.addAll(SHELL); }));
    self.skipWaiting();
});

self.addEventListener('activate', function(e) {
    e.waitUntil(caches.keys().then(function(keys) {
        return Promise.all(keys.filter(function(k) { return k !== CACHE; })
                               .map(function(k) { return caches.delete(k); }));
    }).then(function() { return self.clients.claim(); }));
});

self.addEventListener('fetch', function(e) {
    const req = e.request;
    if (req.method !== 'GET') return;
    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return; // 词典音频等外部请求不管

    if (url.pathname.endsWith('.mp3')) {
        e.respondWith(caches.open(CACHE).then(function(c) {
            return c.match(req).then(function(hit) {
                return hit || fetch(req).then(function(res) {
                    if (res.ok) c.put(req, res.clone());
                    return res;
                });
            });
        }));
        return;
    }

    e.respondWith(fetch(req).then(function(res) {
        if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(function(c) { c.put(req, copy); });
        }
        return res;
    }).catch(function() {
        return caches.match(req, { ignoreSearch: true });
    }));
});
