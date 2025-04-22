## Dome R2 Presigned URLs

**Time‑limited “signed PUT” uploads & downloads from a Cloudflare Worker**

---

### 1 What this covers

| Operation      | Purpose                                                                                                | Lifetime              |
| -------------- | ------------------------------------------------------------------------------------------------------ | --------------------- |
| **Signed PUT** | Let a browser or off‑platform service upload _directly_ to R2 without piping bytes through your Worker | Any duration ≤ 7 days |
| **Signed GET** | Give someone a private, time‑boxed download link                                                       | Same                  |

Everything is done inside a Worker using **aws4fetch** (AWS Signature V4 in query‑string).
No S3 SDK, no extra dependencies, and it works with the standard R2 endpoint.

---

### 2 Environment variables & Wrangler

```toml
# wrangler.toml
[vars]
ACCOUNT_ID = "<cf_account_id>"        # 32‑hex string
BUCKET_NAME = "dome-external"

[unsafe]
bindings = [
  { type="secret_text", name="R2_ACCESS_KEY_ID" },
  { type="secret_text", name="R2_SECRET_ACCESS_KEY" }
]
```

Set the secrets once:

```
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
```

Use an **R2 API token** with read + write restricted to the bucket.

---

### 3 Worker code (single file)

```ts
import { AwsClient } from 'aws4fetch';

interface Env {
  ACCOUNT_ID: string;
  BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
}

const aws = (env: Env) =>
  new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto', // R2 ignores region
  });

export default {
  async fetch(req: Request, env: Env) {
    const url = new URL(req.url);
    const key = url.searchParams.get('key') ?? '';
    if (!key) return new Response('missing key', { status: 400 });

    const expires = Number(url.searchParams.get('exp') ?? 3600); // default 1 h
    const method = req.method === 'POST' ? 'PUT' : 'GET'; // POST = sign‑PUT

    const base = `https://${env.BUCKET_NAME}.${env.ACCOUNT_ID}.r2.cloudflarestorage.com/${key}`;
    const signed = await aws(env).sign(new Request(base, { method }), {
      aws: { signQuery: true },
      expiration: expires,
    });

    return Response.json({ url: signed.url, method });
  },
};
```

**Routes**

- `POST /signer?key=<object>&exp=<seconds>` → JSON `{ url, method:"PUT" }`
- `GET  /signer?key=<object>&exp=<seconds>` → JSON `{ url, method:"GET" }`

(Adjust the router if you prefer explicit paths like `/sign-upload`.)

---

### 4 Client usage

```js
/* UPLOAD */
const { url } = await fetch('/signer?key=external/user/avatar.png&exp=900', {
  method: 'POST', // tells the Worker to sign a PUT
}).then(r => r.json());

await fetch(url, {
  method: 'PUT',
  body: fileBlob,
  headers: {
    // optionally supply Content-Type
    'content-type': fileBlob.type,
  },
});

/* DOWNLOAD */
const { url: downloadUrl } = await fetch('/signer?key=external/user/avatar.png&exp=600').then(r =>
  r.json(),
);

window.location.href = downloadUrl; // direct navigation, or fetch(downloadUrl)
```

_No Worker body size limits apply because the browser talks straight to R2._

---

### 5 Security & best practices

- **Set `exp` conservatively** (minutes, not days) unless you truly need long‑lived links.
- **Validate `key`** on the server (e.g., ensure the user only signs their own prefix `external/<uid>/…`).
- Use `ResponseContentDisposition` / `ResponseContentType` parameters in the presign if you want “download as foo.pdf”.
- Revoke a URL early by **moving or deleting** the object—it invalidates the signature.

---

> Drop this file into a Worker (`/services/r2-signer`) and you have production‑ready, time‑limited upload & download links for any R2 bucket in your account.
