### Design Doc

**Phase 1 Refactor: Privy-only external identity support (Stytch deferred)**

---

#### 1 · Goals (v1 scope)

| Goal                                                                                                         | Success metric                                     |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| Accept **Privy access JWTs** as an alternative to the existing local-password auth flow.                     | Valid Privy JWT → 200 from `/validate`.            |
| Keep a single canonical `User` record & propagate a slim, provider-agnostic `identity` struct via `baggage`. | `identity` header ≤ 300 B.                         |
| Avoid any Privy-specific logic outside the **auth** worker.                                                  | No JWKS / Privy SDK in dome-api or other services. |
| Preserve low latency: < 2 ms p50 for auth look-ups through dome-api.                                         | Metric `auth.cache.hit_rate` ≥ 95 %.               |

---

#### 2 · Request path overview

```
Browser ─(Bearer <privy-jwt>)─► dome-api
dome-api ──► auth /validate  ──► verify Privy JWT
                        │
                        └─► DB: users + user_auth_providers
                ◄───────┘
dome-api ← { user, ttl }      (cache jwt→user for ttl)
dome-api ─(baggage:user=…)─► any downstream service
```

- **Browser keeps the Privy JWT**; no internal token is minted.
- **auth** remains the single place that understands Privy signatures or claims.

---

#### 3 · Data-model additions (unchanged except “privy” as the only external provider)

```sql
CREATE TABLE user_auth_providers (
  id               UUID PRIMARY KEY,
  user_id          UUID REFERENCES users(id),
  provider         TEXT,            -- 'privy' | 'local'
  provider_user_id TEXT,            -- JWT sub
  email            TEXT,
  linked_at        TIMESTAMP,
  UNIQUE(provider, provider_user_id)
);
```

_Backfill_ every existing user with a `provider='local'` row.

---

#### 4 · auth worker changes

##### 4.1 `/validate` route

```
POST /validate   (body: raw Privy JWT)
→ 200 { user, cacheTtlSeconds }
→ 401 / 403 on failure
```

##### 4.2 Verification pipeline (Privy only)

1. **Decode header** – expect `alg: ES256`, issuer `https://api.privy.io`.
2. **JWKS cache** – `jwksCache[kid]` in global scope; on miss fetch Privy’s JWKS endpoint and cache for 60 min.
3. **`crypto.subtle.verify`** signature.
4. Validate `aud`, `exp`, `nbf` (30 s clock skew).
5. Map or create user via `user_auth_providers` (`provider='privy'`, `provider_user_id=sub`).
6. Respond with `{ user, cacheTtlSeconds = min(exp-now, 300) }`.

##### 4.3 Revocation

- On logout/ban: `kv.put("revoked_jti:"+jti, "1", { expirationTtl: exp-now })`.
- `/validate` checks revocation KV before signature verification for fast fail.

##### 4.4 Metrics

| Metric                    | Labels                                                  |
| ------------------------- | ------------------------------------------------------- |
| `rpc.validate.requests`   | provider=privy                                          |
| `rpc.validate.success`    | provider=privy                                          |
| `rpc.validate.fail`       | provider=privy, reason (`sig`, `expired`, `revoked`, …) |
| `jwks.cache.hit` / `miss` | provider=privy                                          |

---

#### 5 · dome-api authentication middleware (refactor)

```ts
const token = authHeader.slice(7);
const cached = identityCache.get(token);
let user: User;

if (cached && cached.exp > Date.now()) {
  user = cached.user;
} else {
  const res = await c.env.AUTH.fetch('/validate', { method: 'POST', body: token });
  if (!res.ok) return proxyAuthError(res, c);

  const { user: u, cacheTtlSeconds } = await res.json();
  user = u;
  identityCache.set(token, { user, exp: Date.now() + cacheTtlSeconds * 1000 });
}

c.set('userId', user.id);
c.set('userRole', user.role);
c.set('userEmail', user.email);

/* propagate via baggage */
const mini = { id: user.id, role: user.role, email: user.email };
c.req.header('baggage', encodeBaggagePair('user', base64url(JSON.stringify(mini))));

await next();
```

_LRU cache_: 10 k entries → \~3 MB mem; eviction ≈ LRU.

---

#### 6 · Downstream services

- Parse `baggage` once, hydrate request context with `identity` (no JWT needed).
- Optional: verify `X-Dome-Sig` HMAC signature if added for tamper-proofing.

---

#### 7 · Security considerations

| Threat                             | Mitigation                                                 |
| ---------------------------------- | ---------------------------------------------------------- |
| Privy key rotation                 | Cache JWKS by `kid`; on signature failure, force refresh.  |
| JWT replay                         | Validate `aud` matches your Privy App ID; honour `exp`.    |
| Header size bloat                  | Only `{ id, role, email }` propagated.                     |
| Quick revocation                   | `cacheTtlSeconds≤300`; KV revocation check bypasses cache. |
| Privilege escalation via Privy JWT | Role comes strictly from your DB, not the JWT claims.      |

---

#### 8 · Migration & rollout

| Week    | Task                                                                                          |
| ------- | --------------------------------------------------------------------------------------------- |
| **0–1** | Implement `user_auth_providers`, backfill local records.                                      |
| **2**   | Add Privy verifier & `/validate`; unit tests with canned JWTs.                                |
| **3**   | Refactor dome-api middleware with LRU + baggage.                                              |
| **4**   | Canary traffic behind `FEATURE_PRIVY`; watch `auth.cache.hit_rate`, p95 latency.              |
| **5**   | Full rollout → update frontend to send Privy JWT.                                             |
| **6+**  | Gather metrics; if stable, retire legacy password UI (optional) and plan next provider phase. |

---

#### 9 · Testing plan

- **Unit** – verifier: positive, wrong signature, wrong aud, expired.
- **Integration** – Miniflare: browser → dome-api → auth; assert baggage & cache stats.
- **Load** – k6 @ 5 k RPS, 95 % cache hits, expect < 0.4 ms p50 added overhead.
- **Security** – Pen-test header smuggling, JWKS key-confusion, clock skew.

---

**Outcome (Phase 1)**
dome-api now authenticates requests bearing **Privy** JWTs with minimal latency and no Privy dependency in business services. The infrastructure remains ready to add new providers later by extending only the auth worker.
