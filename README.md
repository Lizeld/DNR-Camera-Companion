# DNR Camera Companion — web app

Browser port of the Android `WatermarkAndroid` app, built to
[`WEBAPP_SPEC.md`](WEBAPP_SPEC.md).

```
Canon EOS R50 ──► ingest ──► watermark ──► SKU barcode ──► group by SKU ──► S3 ──► inventory draft
```

---

## Quick start

```bash
python tools/make_fixtures.py
```

```bash
python serve.py --camera 192.168.0.158
```

Open the **tablet** URL it prints (`http://<lan-ip>:8000/`) — over HTTP, not
HTTPS, and use that exact URL on every device including the serving PC. Then set
the camera URL and backend credentials in **Settings**.

`--camera` is what keeps the camera's CORS setting alive; see below for why it
is not optional in practice. It is remembered, so later runs are just
`python serve.py`.

If uploads fail, add `--backend https://inventory.example.com` and set
**Settings → Backend URL** to `/backend`. See *Backend CORS* below for why that
is usually necessary. It is remembered too.

### Using it (operator)

Once Settings has the camera address and the Inventory site + upload token,
the **Shoot** tab is all an operator needs: press **Start shooting**,
photograph a part, finish with a close-up of its SKU label, repeat. Each part
appears under *Recent parts* with its upload state, a **Retry** if it failed and
an **Open in Inventory** link once the draft exists. Problems surface as
banners with the one button that fixes them; **Help** in the top bar has the
troubleshooting guide. Counters and the activity log live under *Technical
details*, and everything beyond the essentials under *Settings → Advanced*.

Test suite: `http://<lan-ip>:8000/tests.html` — 143 tests, ~2s.

Requirements: Python 3.9+ with Pillow (fixtures/golden image only). The app
itself has **no build step and no dependencies** — plain ES modules.

---

## Deployment: why it is LAN-served over plain HTTP

Spec §5.1 is the constraint that dictates everything. The camera is a device on
the local network serving plain HTTP with a private IP:

- an `https://` page cannot `fetch()` `http://192.168.1.55:8080` — mixed content
- `https://192.168.1.55` fails cert validation (self-signed)
- Chrome's Private Network Access wants `Access-Control-Allow-Private-Network`
  on a preflight, which CCAPI does not send

So the app **cannot** be hosted at `https://inventory.lizeld.com` and talk to
the camera. `serve.py` implements **option A**: serve it from the LAN over HTTP
so every camera request is same-scheme HTTP→HTTP.

### The cost, and one finding the spec does not mention

A plain-HTTP LAN origin is **not a secure context**. §5.1 notes this costs
service workers and Wake Lock. It also costs **OPFS** — `navigator.storage
.getDirectory()` is secure-context-gated, so the storage design in §5.3/§5.4 is
unavailable in the recommended deployment.

The app handles this rather than breaking: `src/core/blobstore.js` prefers OPFS
and falls back to a Blob in IndexedDB. §5.4 warns against "IndexedDB blobs", but
that warning is about *memory*, and a Blob in IndexedDB is disk-backed in Chrome
and Firefox — what must be avoided is retaining decoded frames, which the worker
never does. **Settings → Diagnostics** shows which backend is live.

Wake Lock degrades the same way: the app says so plainly and tells the operator
to set the device screen timeout to Never.

| Where you open it | Secure context | Byte store | Wake Lock | Can reach the camera |
|---|---|---|---|---|
| `http://<lan-ip>:8000` (tablet) | no | IndexedDB | no | **yes** |
| `http://localhost:8000` (same machine) | yes | OPFS | yes | yes |
| `https://public-host` | yes | OPFS | yes | **no** (§5.1) |

### Camera CORS: let the server handle it

**Nothing works until the camera is told to accept the app's origin, and the
browser can never do it** — the CORS endpoints are themselves subject to CORS,
so the request is blocked before it is sent. A factory camera reports:

```
cors/corssetting  {"value": "disable", "ability": ["disable", "enable"]}
cors/origin       {"origin": ""}
```

Worse, this is **not a one-time setup**. Observed on real hardware: after the
camera powered off, the origin string survived but `corssetting` had reverted
to `"disable"`. It has to be re-applied on every camera power cycle.

So the server does it for you:

```bash
python serve.py --camera 192.168.0.158
```

It registers its own origin at startup, then re-checks every 20 seconds and
re-enables within moments of the camera waking. The camera IP is remembered in
`.dnr-serve.json`, so later runs are just `python serve.py`. Verified by forcing
`corssetting: disable` and watching it recover unaided.

**One origin serves every device.** The registered origin is where the app is
*served from*, not the machine viewing it — any tablet, phone or PC that opens
`http://192.168.0.153:8000` sends that same origin. Adding client devices needs
no camera changes at all.

Moving the *server* to a different machine is also handled: run
`python serve.py --camera <ip>` there and it registers that machine's address
instead. Two caveats:

- Open the app at the **exact** URL the server prints — scheme, host and port
  must match. `localhost` and the LAN IP are different origins.
- If clients reach the server by hostname rather than IP, register that instead:
  `--allow-origin http://dnr-pc:8000`. A DHCP reservation for the serving
  machine keeps the origin stable.

The camera does accept `"*"` as an origin value, but it is unnecessary given the
above and it lets any web page you visit reach the camera on your LAN.

For diagnosis and one-off changes there is still
[`tools/camera_probe.py`](tools/camera_probe.py) — `scan` a /24, `info` one
host, `allow` an origin. It runs outside the browser, so it is the tool that
distinguishes "unreachable" from "CORS-blocked".

### Camera power settings will end a shoot

Read off a real body during testing: `autopoweroff: 180` and `displayoff: 60`.
The camera powers down after three minutes idle, which kills polling — and takes
the CORS enable flag with it. Set auto power off to **Disable** in the camera
menu before a shoot. (The CORS keeper covers the flag; nothing can cover a
camera that is off.)

### Before a real shoot, prove these two things (§9)

1. **A `fetch()` from this origin reaches the camera.** Settings → *Test
   connection* does exactly this and prints the resolved endpoint table.
   Configure camera CORS first (Settings → *Allow this origin*, or the camera
   menu).
2. **A 24MP photo survives decode → watermark → encode.** Measured on the
   development machine: 6000×4000 in ~450 ms/frame over six consecutive frames
   with a flat 2 MB JS heap. Re-run this on the actual tablet — that is where
   tab kills happen.

Both were verified against the real EOS R50 (firmware 1.5.0), not just
synthetically. Three consecutive frames pulled off the card and processed:

| | download | throughput | decode | barcode | render | encode | SKU |
|---|---|---|---|---|---|---|---|
| IMG_7127 (label) | 8.13 MB / 2.31 s | 3.53 MB/s | 156 ms | 124 ms | 63 ms | 602 ms | **0000699** |
| IMG_7126 | 5.79 MB / 1.85 s | 3.13 MB/s | 134 ms | 152 ms | 21 ms | 972 ms | null |
| IMG_7125 | 5.56 MB / 1.68 s | 3.31 MB/s | 127 ms | 132 ms | 17 ms | 428 ms | null |

The pure-JS Code 128 decoder read a real production label off a real 24 MP
frame, and the two product shots correctly returned nothing — the §2.3 grouping
pattern, unmodified. Throughput measured **above** the spec's ~2 MB/s figure
(§3.1), though the client here was on Ethernet; expect less on a tablet.

Endpoint versions on this body matched §3.2 exactly: `deviceinformation`
ver100, `event/polling` ver110, `contents` ver130. Paging confirmed the §3.4
trap — page 1 of a 6,991-image card returns `IMG_0017`, while the app's
backwards paging correctly returns `IMG_7127` first.

---

## Layout

```
index.html            app shell           tests.html          test suite
styles.css                                serve.py            LAN static server (§5.1 A)
                                                              + camera CORS keeper
                                                              + backend upload proxy
assets/watermark.png  logo (placeholder — replace with the real artwork)

src/core/             pure, testable, no DOM
  dcf.js              transport-agnostic photo identity            §2.4
  grouping.js         the state machine, as a reducer              §2.3
  watermark.js        the parity contract                          §2.1
  code128.js          Code 128 decoder + encoder                   §2.2
  barcode.js          SKU detection: downscale, detect, retry      §2.2
  ccapi.js            camera client + pure response parsers        §3
  db.js               IndexedDB metadata                           §6.2
  blobstore.js        OPFS with an IndexedDB fallback              §5.3
  settings.js         persisted settings + backend URL rules       §4, §7
  log.js              activity log + event bus                     §7

src/worker/
  imaging.worker.js   decode · watermark · barcode · encode        §5.4

src/app/
  orchestrator.js     poll loop · queue · prefetch · grouping      §6.1
  uploader.js         presign → PUT → draft → cleanup              §4
  imaging-client.js   main-thread handle to the worker
  watermark-asset.js  bundled asset + operator override

src/ui/               status · gallery · camera · settings          §7
src/test/             the suite                                     §8
tools/
  watermark_reference.py   the Pillow reference renderer
  make_fixtures.py         generates assets + golden image + labels
```

---

## Implementation notes worth knowing

### Watermark compositing (§2.1)

The spec's critical detail is that both bars go onto **one** overlay composited
**once**, so the bottom-left corner — where both are fully opaque — equals the
bar colour exactly rather than a darker doubled value.

`renderWatermark` draws the equivalent decomposition instead of allocating a
second full-size canvas: the left bar is clipped to the rows *above* the bottom
bar, and the bottom bar (drawn second, opaque throughout the corner) supplies
the corner pixels. Every pixel is composited exactly once, so it is
pixel-identical to the single-overlay formulation and costs ~5 MB instead of
~96 MB on a 24 MP frame.

The gradients are built as explicit per-pixel `ImageData` rather than canvas
gradient stops, because gradient interpolation and dithering are not specified
across browsers and parity is.

Verified: the canvas render matches the Pillow reference **within 2/255 per
channel**, the same bar Android held. See `tests.html` → *Golden-image parity*.

### Barcode: pure JS instead of zxing-wasm (§5.3)

`BarcodeDetector` is used when present, but it is Chrome/Android only — it is
absent even in the browser used to develop this. §5.3 suggests zxing-wasm as the
fallback; this project has no npm toolchain and ships as plain modules off a
static server, so a vendored wasm bundle would be a liability.

`src/core/code128.js` is a full Code 128 decoder instead: run-length line
scanner, least-squares pattern matching against the 107-symbol table, mod-103
checksum, code sets A/B/C, both scan directions, rows and columns. It is ~250
lines, works offline, and is exercised by round-trip tests against its own
encoder plus generated label fixtures.

One subtlety worth recording: a right-to-left scan is **not** a reversed run
list fed back through the forward decoder — reversing flips the element order
inside every symbol too. The reverse path matches a reversed pattern table and
walks stop → start.

### Ingest loop (§6.1)

Ported rule for rule. The one that matters most: **drain the queue in
IMG-sequence order, and on a transient failure of the lowest item stop draining
and retry it next cycle.** That is what guarantees a later SKU photo can never
flush its group while an earlier frame is still missing.

Also carried over: 503/502/504/429/408/304 are empty polls, not failures (the
camera 503s while writing a burst — treating that as a connection failure
stalled the pipeline in production); gaps of 1–100 frames are enqueued, larger
jumps are a new session; the sequence baseline is a high-water mark that never
rewinds.

**One content request at a time.** Measured against the R-series body on the
bench: two concurrent `GET ?kind=main` return one `200` after 3.1s and one
instant `503 {"message":"Device busy"}`; four sequential ones all return `200`
at ~3.5s and ~1.7 MB/s. The `event/polling` endpoint is *not* affected — it
answers `200` while a transfer is streaming — so only content GETs contend.

This is why `drain()` awaits the current photo's bytes **before** starting the
next one's prefetch. Starting the prefetch first (as it originally did) made the
two race; the prefetch won, the head of the queue 503'd on every cycle, and
ingest retried one photo forever without ever advancing — while the prefetched
bytes were overwritten before they could be used, so every photo was fetched
twice. Prefetch overlaps the *decode/barcode/encode* window, never the transfer.
`src/test/orchestrator.test.js` pins this with a fake camera that fails any
overlapping request.

A corollary worth remembering during a shoot: the in-app **camera browser**
downloads thumbnails from the same endpoint, so browsing the card while ingest
is running will make both sides retry. Ingest recovers, but it is slower.

### Upload idempotency (§4)

Each photo's `publicUrl` is persisted the moment its PUT succeeds, and the draft
is built from *all* uploaded photos for the SKU — so a retry after a partial
failure completes the set rather than creating a short draft. Local bytes are
deleted only after the draft is confirmed.

The backend makes the rest of it safe (DNR-Inventory `routes/watermark.js`):
`/presign` appends a random suffix to the key, because Canon file numbers wrap
at 9999 and a bare `listings/IMG_0017.JPG` would overwrite an older listing's
photo; and `/drafts` returns the existing draft when the same image keys arrive
twice, so a retry after a lost response can't create a duplicate.

**Reshoots append.** If a SKU already has photos in a draft, a later shoot of the
same SKU sends only the new photos plus that `draftId`, and the backend adds them
to the draft (`planDraft()` in `uploader.js`). If the draft has been published
in the meantime, the backend makes a new draft instead.

Both §4 traps are handled in `settings.backendApiBase()`: the `/api` prefix is
forced (root paths are the SPA and return nginx 405) and the scheme is forced to
`https` (an `http://` base 301-redirects and fetch downgrades POST to GET,
answered with 405). Uploads also use `redirect: 'error'` so a surprise redirect
is loud instead of silently becoming a GET.

**The S3 bucket needs CORS** allowing `PUT` from the app origin with the
`Content-Type` header. Android did not need this; browsers do. Without it every
upload fails at the PUT with an opaque network error — the uploader's error
message says so explicitly.

### Backend CORS: the wall Android never hit

The LAN origin that makes the camera reachable is what makes the *backend*
unreachable. Observed against the production API: a preflight from
`http://192.168.0.153:8000` comes back with

```
Access-Control-Allow-Origin: http://localhost:5173
```

and it returns that same value for *every* origin, including junk ones — a
hardcoded dev origin, not an allowlist. So the browser discards the response and
`fetch` rejects before any status exists. Firefox words it "NetworkError when
attempting to fetch resource", which reads exactly like a missing endpoint;
`/api/presign` is in fact live and answers `401 Missing bearer token` to any
client that is not a browser. **The Android app was never affected — OkHttp does
not enforce CORS.** This is new ground for the web port, not a regression.

`Access-Control-Allow-Credentials: true` is set upstream, so a `*` wildcard is
not an option there; the origin has to be named. Two ways out:

**Fix it upstream** — set `WATERMARK_APP_ORIGINS=http://<lan-ip>:8000` on the
Inventory backend (it allows those origins, without credentials, on the
watermark endpoints only), add the same origin to the bucket's CORS rules, and
give the serving PC a DHCP reservation so the origin stays put.

**Or proxy it** (`--backend`), which needs nothing from either:

```
POST /backend/api/presign  ->  {upstream}/api/presign
POST /backend/api/drafts   ->  {upstream}/api/drafts
PUT  /backend/s3?t=..&sig=..  ->  the presigned S3 URL
```

`serve.py` rewrites `uploadUrl` in the presign response to point back at itself,
so the PUT is same-origin too and the bucket's CORS never comes into it either.
`publicUrl` is left untouched — it is stored per photo and sent to `/drafts`, so
it must stay the real bucket link. The bearer token is forwarded untouched and
nothing is stored.

Notes on the proxy worth knowing:

- Those rewritten S3 URLs carry their target in the query string, so they are
  HMAC-signed with a **per-process** key. A server restart invalidates
  outstanding ones; the SKU re-presigns on retry. Without the signature the PUT
  route would relay bytes anywhere a LAN client asked it to.
- Image bytes now transit this process instead of going straight to S3. On a LAN
  that is not worth noticing, but it does drop §4's "bytes never transit the
  backend" property locally.
- Redirects are never followed (§4 trap 2): a 301 is reported as a 301 rather
  than being silently downgraded to a GET.
- `GET /backend/config` reports what is proxied and where it goes.
- `GET /backend/api/watermark/*` (token check, SKU lookup, draft status) is
  proxied too — read-only, and nothing else of the site is reachable through it.

### Inventory lookups

The Shoot tab asks the backend, best effort and cached, what each SKU is
(`GET /api/watermark/skus/:sku` — item title and car, or "not in Inventory",
which usually means a misread label) and how each uploaded draft is doing
(`GET /api/watermark/drafts/:id` — OpenClaw analysis, part number, price). They
have their own rate-limit budget on the backend, so they can't starve uploads,
and nothing in the shooting flow waits on them. **Open in Inventory** links go to
`<site>/listings?id=<draftId>`.

### Foreground-only (§5.2)

A genuine regression versus Android, and the app is honest about it: a banner on
the Status screen, a warning in the log when the tab is backgrounded, a report of
how long it was away on return, and a **Re-sync newest 60** button that pulls the
card listing and skips anything already handled by DCF key.

---

## Known deviations

| Item | Status |
|---|---|
| JPEG chroma subsampling | 4:2:0, not the original's 4:4:4 (`subsampling=0`). Neither Android's encoder nor `canvas.toBlob()` exposes it. Same deviation Android accepted (§2.1). Verify visually on label edges; if it ever matters, encode via a WASM mozjpeg configured for 4:4:4. |
| USB / WebUSB | Descoped per §3.7. |
| `assets/watermark.png` | A generated **placeholder** at the production 796×854. Replace it with the real artwork, or load one from Settings. |
| Camera CORS write | The read path is reliable; the write payload shape is undocumented, so *Allow this origin* tries the plausible variants and shows the camera's verbatim reply rather than claiming success. |

---

## Testing (§8)

`tests.html` — 119 tests covering:

- **Golden-image parity** against the Pillow reference, bitmap-vs-bitmap so the
  4:2:0 deviation cannot confound it, max channel diff ≤ 2/255
- **Grouping reducer** — SKU flush, 30/35 thresholds, gap boundaries (100
  reported, 101 ignored), high-water mark not rewinding, dedup, purity
- **DCF key** — the same photo via five different routes yields one key
- **Barcode regression** — generated labels with a known SKU: normal contrast,
  rotated 90°, and low contrast that forces the 2.5× retry
- **Camera contract** — recorded CCAPI response shapes parsed offline
- **Code 128** — round trip, both directions, checksum rejection, noise rejection
- **Backend URLs** — both §4 traps

Regenerate fixtures after changing the reference renderer:

```bash
python tools/make_fixtures.py
```

Render a real photo through the reference implementation:

```bash
python tools/watermark_reference.py render photo.jpg out.png
```
