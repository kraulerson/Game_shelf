# EA App Launcher — Design Spec

**Date:** 2026-03-25
**Version:** 1.13.0 (current)
**Scope:** Implement EA App launcher using OAuth auth_code flow and EA's Juno GraphQL API, following the same pattern as Epic and GOG.

## Motivation

EA App is one of three stub launchers (along with Ubisoft and Battle.net) currently showing "Coming Soon." EA has an undocumented but well-understood GraphQL API (used by GOG Galaxy's integration plugin) that supports OAuth authorization code flow — a perfect match for the existing launcher patterns.

## Approach

OAuth auth_code flow with EA's Juno GraphQL API. User logs in via browser, copies auth code, server exchanges for tokens and queries game library. Same UX and architecture as Epic/GOG launchers.

## Authentication Flow

User visits EA's OAuth URL in their browser:

```
https://accounts.ea.com/connect/auth?response_type=code&client_id=JUNO_PC_CLIENT&display=junoClient/login&redirect_uri=qrc:///html/login_successful.html&locale=en_US
```

After login (including any 2FA/captcha), EA redirects to a page containing the auth code. User copies the code and pastes it into the Setup/Settings page — same UX as Epic and GOG.

Server exchanges the code at `https://accounts.ea.com/connect/token` with:

- `client_id=JUNO_PC_CLIENT`
- `client_secret=4mRLtYMb6vq9qglomWEaT4auACSQmaccrOyR2`
- `grant_type=authorization_code`
- `redirect_uri=qrc:///html/login_successful.html`
- `token_format=JWS`

Response includes `access_token` (JWT Bearer) and `refresh_token`.

Stored credentials shape:
```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_at": "2026-03-25T12:00:00Z"
}
```

`refreshIfNeeded()` checks `expires_at`. If expired, calls the same token endpoint with `grant_type=refresh_token`. Returns `{ session, updatedCredentials }` so the sync engine persists the new tokens.

## Game Library Query

`fetchOwnedGames()` POSTs to `https://service-aggregation-layer.juno.ea.com/graphql` with headers:

- `Authorization: Bearer <access_token>`
- `User-Agent: EAApp/PC/13.468.0.5981/GOG_Galaxy`
- `x-client-id: EAX-JUNO-CLIENT`
- `Content-Type: application/json`

GraphQL query:

```graphql
query getPreloadedOwnedGames($next: String, $locale: Locale, $limit: Int,
    $type: [GameProductType!]!, $entitlementEnabled: Boolean,
    $storefronts: [UserGameProductStorefront!],
    $ownershipMethods: [OwnershipMethod!],
    $platforms: [GamePlatform!]!) {
  me {
    ownedGameProducts(
      storefronts: $storefronts
      locale: $locale
      paging: {limit: $limit, next: $next}
      productFound: true
      orderBy: {field: NAME, direction: ASC}
      ownershipMethod: $ownershipMethods
      type: $type
      downloadableOnly: false
      entitlementEnabled: $entitlementEnabled
      platforms: $platforms
    ) {
      items {
        id: originOfferId
        status
        product {
          id
          name
          gameSlug
          baseItem(availabilities: [VISIBLE]) {
            title
            gameType
          }
          gameProductUser(storefronts: $storefronts) {
            ownershipMethods
            entitlementId
          }
        }
      }
    }
  }
}
```

Variables:

```json
{
  "locale": "DEFAULT",
  "limit": 9999,
  "type": ["DIGITAL_FULL_GAME", "PACKAGED_FULL_GAME"],
  "entitlementEnabled": true,
  "storefronts": ["EA"],
  "platforms": ["PC"],
  "ownershipMethods": ["PURCHASE", "REDEMPTION", "ENTITLEMENT_GRANT"]
}
```

Each response item maps to:
- `originOfferId` → `launcher_game_id`
- `product.name` → `title`
- `product.baseItem.gameType` → filter: keep `BASE_GAME`, filter out DLC/trials/demos

Returns the standard `[{ launcher_game_id, title, playtime_minutes: 0 }]` array that the sync engine expects. No playtime query (owned games only).

## Registration & Frontend Changes

Change the EA launcher registration in `launchers.js` from:

```js
{ id: 'ea', display_name: 'EA App', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: false }
```

To:

```js
{ id: 'ea', display_name: 'EA App', auth_type: 'auth_code', otp_supported: false, qr_supported: false, implemented: true }
```

The frontend already handles `auth_code` type — shows a link to the OAuth URL and a code input field. No frontend code changes needed.

## Testing

### Unit Tests

- `authenticate()` — mock token endpoint, verify tokens stored correctly
- `refreshIfNeeded()` — mock refresh, verify new tokens returned; verify skip when not expired
- `fetchOwnedGames()` — mock GraphQL response, verify correct game list returned
- Filter non-games (DLC, trials) from results
- Handle expired/invalid token (401 response)

### Integration

Verify the standard sync flow works — credentials persist, game_editions upserted, edition tiers detected.

## References

- [BellezaEmporium/galaxy-integration-ead](https://github.com/BellezaEmporium/galaxy-integration-ead) — GOG Galaxy EA Desktop plugin (primary reference for GraphQL API and OAuth flow)
- EA token endpoint: `https://accounts.ea.com/connect/token`
- EA GraphQL endpoint: `https://service-aggregation-layer.juno.ea.com/graphql`
