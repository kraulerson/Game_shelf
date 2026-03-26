# Ubisoft Connect Launcher — Design Spec

**Date:** 2026-03-25
**Version:** 1.14.4 (current)
**Scope:** Implement Ubisoft Connect launcher using email/password Basic Auth and Ubisoft's GraphQL API for fetching owned games.

## Motivation

Ubisoft Connect is one of two remaining stub launchers (along with Battle.net). Ubisoft has an undocumented HTTP API (used by GOG Galaxy's integration plugin) that supports email/password login with 2FA and a GraphQL endpoint for game libraries.

## Approach

Email/password Basic Auth to Ubisoft's sessions endpoint. Stores short-lived `ticket` and long-lived `rememberMeTicket` for refresh. 2FA handled via existing two-phase sync flow. GraphQL query for owned games.

## Authentication Flow

User provides email and password in the Setup page (existing `credentials+totp` UI).

**Initial login:** Server sends:
```
POST https://public-ubiservices.ubi.com/v3/profiles/sessions
Authorization: Basic <base64(email:password)>
Ubi-AppId: f35adcb5-1911-440c-b1c9-48fdc1701c68
Content-Type: application/json
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
Body: {"rememberMe": true}
```

**Success response** returns: `ticket`, `sessionId`, `rememberMeTicket`, `userId`, `expiration`.

**2FA response** (email verification enabled): Returns `twoFactorAuthenticationTicket` instead of a ticket. The launcher throws `OTP_REQUIRED:Check your email for a verification code` — triggering the existing two-phase sync flow. User enters code from email on the Settings page. Second request sends:
```
POST https://public-ubiservices.ubi.com/v3/profiles/sessions
Authorization: ubi_2fa_v1 t=<twoFactorAuthenticationTicket>
Ubi-AppId: f35adcb5-1911-440c-b1c9-48fdc1701c68
Ubi-2faCode: <code>
Content-Type: application/json
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
Body: {"rememberMe": true}
```

**Stored credentials after successful auth:**
```json
{
  "email": "user@example.com",
  "password": "...",
  "ticket": "...",
  "sessionId": "...",
  "rememberMeTicket": "...",
  "userId": "...",
  "expiration": "2026-03-25T12:00:00.000Z"
}
```

**Refresh:** `refreshIfNeeded()` checks `expiration`. If expired, uses `rememberMeTicket`:
```
POST https://public-ubiservices.ubi.com/v3/profiles/sessions
Authorization: rm_v1 t=<rememberMeTicket>
Ubi-AppId: f35adcb5-1911-440c-b1c9-48fdc1701c68
Content-Type: application/json
Body: {"rememberMe": true}
```

Returns new `ticket`, `sessionId`, `rememberMeTicket`, and `expiration`. If rememberMeTicket refresh fails, falls back to full email/password login (triggering 2FA again if needed).

## Game Library Query

`fetchOwnedGames()` POSTs to `https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql` with headers:
- `Authorization: Ubi_v1 t=<ticket>`
- `Ubi-AppId: f35adcb5-1911-440c-b1c9-48fdc1701c68`
- `Ubi-SessionId: <sessionId>`
- `Content-Type: application/json`
- Browser-like `User-Agent`

GraphQL query:
```graphql
query AllGames {
  viewer {
    id
    ...ownedGamesList
  }
}
fragment gameProps on Game {
  id
  spaceId
  name
}
fragment ownedGameProps on Game {
  ...gameProps
  viewer {
    meta {
      id
      ownedPlatformGroups {
        id
        name
        type
      }
    }
  }
}
fragment ownedGamesList on User {
  ownedGames: games(filterBy: {isOwned: true}) {
    totalCount
    nodes {
      ...ownedGameProps
    }
  }
}
```

Each node returns `id`, `spaceId`, `name`, and `ownedPlatformGroups`. Filter for nodes that have a platform group with `type: "PC"` to exclude console-only games.

Maps to: `{ launcher_game_id: id, title: name, playtime_minutes: 0 }`.

## Registration & Frontend

The existing stub already has the correct registration:
```js
{ id: 'ubisoft', display_name: 'Ubisoft Connect', auth_type: 'credentials+totp', otp_supported: true, qr_supported: false, implemented: false }
```

Flip `implemented: true`. No other registration changes. No frontend changes — the existing `credentials+totp` UI shows email/password fields and the two-phase sync flow handles the "Enter Code" prompt for email 2FA.

## Testing

### Unit Tests

- `authenticate()` — mock sessions endpoint, verify Basic auth header, verify stored credentials shape
- `authenticate()` with 2FA — mock 2FA response, verify throws `OTP_REQUIRED:` error
- `authenticate()` with 2FA code — mock second request with code, verify success
- `refreshIfNeeded()` — skip when ticket not expired
- `refreshIfNeeded()` — use rememberMeTicket when expired, verify new ticket returned
- `fetchOwnedGames()` — mock GraphQL response, verify game list, verify PC-only filtering

## References

- [DragonicDefson/GOGUbisoft](https://github.com/DragonicDefson/GOGUbisoft) — Working GOG Galaxy plugin (primary reference)
- [Openplanet Trackmania API docs - Ubisoft Auth](https://webservices.openplanet.dev/auth/ubi) — Best auth endpoint documentation
- Ubisoft sessions endpoint: `https://public-ubiservices.ubi.com/v3/profiles/sessions`
- Ubisoft GraphQL endpoint: `https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql`
- Ubi-AppId (Club): `f35adcb5-1911-440c-b1c9-48fdc1701c68`
