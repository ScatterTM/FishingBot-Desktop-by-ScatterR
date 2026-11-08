// Derive the channel owner's identity only from Twitch's signed broadcaster
// role and the desktop socket already authenticated against Twitch for the
// exact same channel. Never accept a viewer-supplied username or user ID.
export function resolveBroadcasterViewer(claims, desktop) {
  if (String(claims?.role || '') !== 'broadcaster') return null;

  const channelId = String(claims.channel_id || '');
  if (!/^\d{5,20}$/.test(channelId)) {
    throw Object.assign(new Error('Twitch did not provide a valid broadcaster channel identity.'), {
      status: 401,
      code: 'broadcaster_identity_invalid'
    });
  }

  if (!desktop || desktop.readyState !== 1 || desktop.fishingbotAuthenticated !== true) {
    throw Object.assign(new Error('The broadcaster’s Fishingbot desktop is not connected to this channel.'), {
      status: 503,
      code: 'streamer_offline'
    });
  }

  const desktopChannelId = String(desktop.channelId || '');
  const login = String(desktop.channelLogin || '').trim().replace(/^@+/, '').toLowerCase();
  if (desktopChannelId !== channelId || !/^[a-z0-9_]{1,25}$/.test(login)) {
    throw Object.assign(new Error('The connected Fishingbot desktop does not match the broadcaster channel.'), {
      status: 403,
      code: 'broadcaster_identity_mismatch'
    });
  }

  return {
    userId: channelId,
    login,
    displayName: login,
    avatar: '',
    channelOwner: true
  };
}


// Resolve an ordinary viewer only when Twitch's signed Extension JWT and
// the matching Helix identity token agree on the same platform user ID.
// There is intentionally no username or broadcaster allowlist here.
export function resolveLinkedViewerIdentity(claims, helixToken, user) {
  const userId = String(claims?.user_id || '');
  const unlinked = claims?.is_unlinked === true || String(claims?.is_unlinked).toLowerCase() === 'true';
  if (unlinked || !/^\d{5,20}$/.test(userId)) {
    throw Object.assign(new Error('Share your Twitch identity with Fishingbot to use private account features.'), {
      status: 403,
      code: 'identity_link_required'
    });
  }
  if (!helixToken || String(helixToken).length > 8192) {
    throw Object.assign(new Error('Twitch did not provide a Helix identity token. Refresh the Extension and try again.'), {
      status: 401,
      code: 'helix_token_missing'
    });
  }
  if (!user || String(user.id) !== userId || !/^[a-z0-9_]{1,25}$/i.test(String(user.login || ''))) {
    throw Object.assign(new Error('Twitch could not verify the shared viewer identity. Refresh the Extension and try again.'), {
      status: 401,
      code: 'identity_verification_failed'
    });
  }
  return {
    userId,
    login: String(user.login).toLowerCase(),
    displayName: String(user.display_name || user.login).slice(0, 40),
    avatar: /^https:\/\//i.test(String(user.profile_image_url || '')) ? String(user.profile_image_url) : ''
  };
}
