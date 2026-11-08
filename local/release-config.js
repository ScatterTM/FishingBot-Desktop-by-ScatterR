// Public Fishingbot release configuration.
// websiteTwitchClientId is the optional legacy website Authorization Code OAuth app.
// botTwitchClientId is a separate Twitch OAuth app registered as a Public client.
// The Extension Secret is stored only on the hosted relay.
export const RELEASE_CONFIG = Object.freeze({
  websiteTwitchClientId: "e4or7x7vn8ry639wuyjmi256bhfoot",
  botTwitchClientId: "qlmqge9qb3dj4i8nhm2xuss0kpjumn",
  extensionRelayUrl: "https://fishingbot-extension-relay.onrender.com"
});