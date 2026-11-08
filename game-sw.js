// Minimal service worker: it lets the browser install the app from any page on
// this site. Every request goes to the network as usual; nothing is cached.
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', () => { /* network only */ });
