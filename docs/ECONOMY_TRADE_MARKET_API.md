# OpenVibe economy — Trading & Market API contract

Contract between the backend (`backend/src/economy*.ts`, `routes-economy.ts`)
and the menu UI (`client/index.html` economy hub). Both sides implement THIS
document; if something here turns out to be wrong, fix the doc in the same
change.

Conventions (same as the rest of `/v1/economy/*`):
- Auth: `Authorization: Bearer <session>` — with dev-auth enabled a plain
  `?steamId=` / `body.steamId` fallback works.
- Items are Devolved item-id strings (`item_<Name>`, `crate_<Name>`, bare rare
  names). Defs come from `GET /v1/economy/defs`.
- Bucks = `players.currency_balance`. All balance changes write
  `currency_ledger` rows.
- Errors: `{ error: "<code>" }` with the noted HTTP status (default 400).

## Market (server-wide listings, bucks-priced)

### `GET /v1/economy/market`
Query: `q` (substring match on itemId/displayName), `kind` (EconKind filter),
`sort` = `newest` (default) | `price_asc` | `price_desc`, `page` (1-based,
default 1), `perPage` (default 50, max 100).
Response:
```json
{ "listings": [ { "listingId": 7, "sellerSteamId": "7656...", "sellerName": "Alex",
    "itemId": "Golden Deagle", "price": 500, "createdAt": "2026-07-04T..." } ],
  "total": 123, "page": 1, "perPage": 50 }
```
Only `status='open'` listings. The UI resolves `itemId` → def via the cached
defs list; the backend does not embed defs.

### `POST /v1/economy/market/list` — body `{ slot, price }`
Lists the item sitting in inventory `slot` (item leaves the inventory into
listing escrow). `price` int 1..1_000_000.
Errors: `empty_slot` 404, `invalid_price` 400.
Returns `{ listingId, state }` (state = the standard EconomyStateView).

### `POST /v1/economy/market/buy` — body `{ listingId }`
Atomically: debit buyer (`market:buy:<itemId>`), credit seller
(`market:sale:<itemId>`), item into the buyer's lowest free slot, listing →
`sold`.
Errors: `listing_not_found` 404, `insufficient_bucks` 402, `inventory_full`
409, `cannot_buy_own` 400.
Returns `{ state }`.

### `POST /v1/economy/market/cancel` — body `{ listingId }`
Seller only. Item back to seller's lowest free slot, listing → `cancelled`.
Errors: `listing_not_found` 404, `not_your_listing` 403, `inventory_full` 409.
Returns `{ state }`.

### `GET /v1/economy/market/mine`
`{ listings: [...] }` — the caller's OPEN listings, same entry shape.

## Trading (direct player-to-player offers)

Offers reference item-id strings, not slots (Devolved items are fungible
strings). Nothing is escrowed at offer time; ownership of both sides is
validated atomically at accept time.

### `POST /v1/economy/trade/offer`
Body: `{ toSteamId, offerItemIds: string[] (0..8), offerBucks: int >= 0,
requestItemIds: string[] (0..8), requestBucks: int >= 0, message?: <=200 }`.
At least one of the four give/take fields must be non-empty
(`empty_trade` 400). Sender must currently own `offerItemIds` (`not_owned`
400) and have `offerBucks` (`insufficient_bucks` 402). Other errors:
`self_trade` 400, `player_not_found` 404, `too_many_trades` 429 (cap: 10 open
outgoing).
Returns `{ tradeId }`.

### `GET /v1/economy/trade`
```json
{ "incoming": [ { "tradeId": 3, "fromSteamId": "...", "fromName": "Bob",
    "toSteamId": "...", "toName": "Alex", "offerItemIds": ["Beer"],
    "offerBucks": 0, "requestItemIds": [], "requestBucks": 50,
    "message": "beer 4 bucks", "createdAt": "..." } ],
  "outgoing": [ ... ] }
```
Open offers only.

### `POST /v1/economy/trade/accept` — body `{ tradeId }`
Recipient only. Atomic under BOTH players' locks (acquire in ascending steamId
order — deadlock guard): re-verify sender still owns offerItemIds + offerBucks
and recipient owns requestItemIds + requestBucks, both inventories have room
for what they receive, then swap. Ledger reasons `trade:<tradeId>:send` /
`trade:<tradeId>:receive` on each side's bucks delta. Offer → `accepted`.
Errors: `trade_not_found` 404, `not_your_trade` 403, `missing_items` 409
(either side no longer has the goods — offer auto-cancelled), `insufficient_bucks`
402, `inventory_full` 409.
Returns `{ state }` (the acceptor's state).

### `POST /v1/economy/trade/decline` — body `{ tradeId }` (recipient)
### `POST /v1/economy/trade/cancel` — body `{ tradeId }` (sender)
Offer → `declined` / `cancelled`. Errors: `trade_not_found` 404,
`not_your_trade` 403. Return `{ ok: true }`.

## Storage (migration `004_market_trades.sql`, all idempotent)

```sql
market_listings(
  listing_id bigserial PK,
  seller_steam_id bigint NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
  item_id text NOT NULL REFERENCES econ_defs(def_id),
  price integer NOT NULL CHECK (price > 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','sold','cancelled')),
  sold_to bigint NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL
)
trade_offers(
  trade_id bigserial PK,
  from_steam_id bigint NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
  to_steam_id bigint NOT NULL REFERENCES players(steam_id) ON DELETE CASCADE,
  offer_item_ids jsonb NOT NULL DEFAULT '[]',
  offer_bucks integer NOT NULL DEFAULT 0 CHECK (offer_bucks >= 0),
  request_item_ids jsonb NOT NULL DEFAULT '[]',
  request_bucks integer NOT NULL DEFAULT 0 CHECK (request_bucks >= 0),
  message text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','accepted','declined','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz NULL
)
```

## Existing endpoints the UI builds on (unchanged)

- `GET /v1/economy/defs` → `{ defs: EconDef[] }` (763 seeded defs).
- `GET /v1/economy/state` → EconomyStateView
  `{ player: { steamId, displayName, bucks, xp, lvl, xpInLevel, xpNext },
     inventory: [{ slot, itemId }], loadout, stats }`.
- `POST /v1/economy/crates/open` `{ slot }` → `{ won: "<itemId>", state }` —
  crate roll happens server-side; the UI reel animation must LAND on `won`
  (fetch first, animate after, never re-roll client-side).
- move/sort/use/redeem/unredeem/craft/buy/equip as already implemented.
