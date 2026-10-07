# DNR Watermark — Web App Specification

Port of the Android app (`WatermarkAndroid`) to a browser-based application.
This document is the complete behavioral contract plus an honest assessment of
what the web platform can and cannot do here.

**Read the constraints section first.** Several parts of this app map cleanly to
the browser; one part (talking to the camera) has a hard platform blocker that
dictates the entire deployment architecture.

---

## 1. What the app does

```
Canon EOS R50 ──► ingest ──► watermark ──► SKU barcode ──► group by SKU ──► S3 ──► inventory draft
```

An operator photographs auto parts. Each product gets several shots, and the
**last shot of each group is a label bearing a 7-digit SKU barcode**. The app
pulls photos off the camera as they're taken, watermarks them at full
resolution, reads the SKU, assigns the whole pending group to that SKU, uploads
the finished images to S3, and creates an inventory draft.

It replaced a PC pipeline (Python + Syncthing). The Android version is working
in production; this spec is derived from it and from the original Python.

---

## 2. Behavior spec — the parity contract

This section is **normative**. The Android implementation was proven
pixel-identical to the original Python (max channel difference 2/255 across 6M
pixels). Any port must reproduce it.

### 2.1 Watermark rendering

Given a base image and a watermark PNG:

| Parameter | Value |
|---|---|
| Bar colour | `rgb(70, 90, 120)` |
| Padding (bar thickness + inset) | `125` px |
| Alpha split point | `0.8` |
| Max watermark width | `30%` of base width |
| JPEG quality | `92` |

**Left bar** — width = `padding`, full height. Vertical gradient, alpha
`0 → 255` over the top 80% of height, then solid `255` for the bottom 20%.

**Bottom bar** — height = `padding`, full width. Horizontal gradient, solid
`255` for the left 80%, then `255 → 0` over the right 20%.

**Critical compositing detail.** Both bars are drawn onto a single transparent
overlay which is composited **once**. In the bottom-left corner the bars
overlap, and both are fully opaque there — so the corner must equal the bar
colour exactly, *not* a darker doubled value. In Canvas terms: draw the bottom
bar with `globalCompositeOperation = 'source-over'` onto the overlay (it
overwrites the left bar's pixels in the corner), then draw the overlay onto the
base. Compositing the bars separately onto the base is **wrong** and will fail
parity.

**Watermark placement** — pasted bottom-left at `padding` from the left and
bottom edges. If its width exceeds 30% of the base width, scale down to exactly
30%, preserving aspect ratio.

> In production this never triggers: the watermark asset is 796×854 and the
> photos are 6000×4000, so 30% = 1800px. The paste is 1:1. Keep the rule anyway
> for smaller inputs.

**Export** — JPEG quality 92.

⚠ **Known deviation, carried over from Android.** The original Python used
Pillow with `subsampling=0` (4:4:4 chroma). Neither Android's encoder nor
`canvas.toBlob()` exposes chroma subsampling, so output is 4:2:0. This softens
sharp colour edges slightly. It was judged acceptable on Android; verify
visually on label edges. If it ever matters, encode via a WASM build of
libjpeg-turbo or mozjpeg configured for 4:4:4.

### 2.2 SKU detection

- Valid SKU is **exactly 7 digits**: `/^\d{7}$/`
- **Symbology is Code 128** (confirmed empirically against real labels)
- Read from a **downscaled copy, longest side ~1600px** — 3–4× faster and
  sufficient, because the label is shot deliberately at close range
- On failure, retry once with a **2.5× contrast boost applied to greyscale**
- Only the last photo of a group is expected to carry a label; most photos
  legitimately return nothing

### 2.3 Grouping state machine

Ported from the original `scheduler.py`. Pure and deterministic — implement it
as a reducer and unit-test it with synthetic event streams.

- Photos accumulate in a **pending group**
- On SKU detection, the **entire pending group** (including the label photo) is
  assigned that SKU and released for upload; the pending group resets
- **Stale warning at 30** photos with no SKU
- **Auto-evacuate at 35** — move the group to a "review" bucket and reset
- **Sequence gaps**: track Canon `IMG_XXXX` numbers. Report a gap when the
  number of *missing frames* is in `1..100`. A gap larger than 100 is a new
  shooting session — ignore it silently.
- The sequence baseline is a **high-water mark** (`max`). An out-of-order lower
  number must never rewind it, or a card swap floods the log with false gaps.
- **Dedup**: never reprocess a photo already handled.

### 2.4 Photo identity

Identity must be **transport-agnostic**, because the same photo can arrive by
different routes and must not be processed twice.

Use the **DCF key**: `<folder>/<filename>`, e.g. `100CANON/IMG_0017.JPG`.

- From a CCAPI path (`/ccapi/ver130/contents/card1/100CANON/IMG_0017.JPG`),
  take the last two segments
- Never key on a CCAPI URL (contains an API version) or a PTP object handle
  (not stable across sessions)

---

## 3. Camera integration (CCAPI)

All of the following was established empirically against a real EOS R50
(firmware 1.5.0). The official 929-page CCAPI reference does not make several of
these obvious.

### 3.1 Connection

| Property | Value |
|---|---|
| HTTPS | port **443**, **self-signed certificate** |
| HTTP | port **8080** |
| Toggle | camera menu (connection setup), not via API |

**Use HTTP.** Measured throughput: **~1.5 MB/s over HTTPS vs ~1.95 MB/s over
HTTP** (+30%) — the camera's SoC is the bottleneck when encrypting. TLS buys
nothing on a LAN against a self-signed cert that isn't being verified anyway.

Realistic ceiling is **~2 MB/s (~16 Mbps)**. That is the camera's radio. Don't
chase it with software.

### 3.2 Discovery — resolve endpoints, don't construct them

`GET /ccapi` returns a map of version keys to arrays of endpoint descriptors:

```json
{
  "ver100": [ { "path": "/ccapi/ver100/deviceinformation", "get": true }, ... ],
  "ver110": [ { "path": "/ccapi/ver110/event/polling", ... } ],
  "ver130": [ { "path": "/ccapi/ver130/contents", ... } ]
}
```

**Resolve each function by matching its path suffix across all versions.**
Do not assume a version prefix. On the R50:

| Function | Actual version |
|---|---|
| `deviceinformation` | ver100 |
| `event/polling` | **ver110** |
| `contents` | **ver130** |

Constructing `/ccapi/ver130/event/polling` returns 404.

### 3.3 Event polling — bare GET, no query parameters

```
GET /ccapi/ver110/event/polling
```

- `?continue=off` or `?continue=on` → **400 "Illegal query parameter"**
- `?timeout=long` → streams indefinitely; **crashed the Android client**
- Idle response is `{}`
- New captures appear as `addedcontents`: an array of absolute path strings

Poll on a ~1s interval. Response also carries `currentdirectory`, but **only on
full-state polls**, not on incremental ones — do not depend on it.

**Handle 503 as transient, not fatal.** The camera returns 503 while writing a
burst to the card. Treating it as a connection failure tears down the session
and stalls the pipeline (this was a real production bug). Treat
`503/502/504/429/408/304` as "empty poll" and keep going.

### 3.4 Contents browsing

```
/ccapi/ver130/contents           → {"path":["/ccapi/ver130/contents/card1"]}
/ccapi/ver130/contents/card1     → {"path":[".../100CANON"]}
/ccapi/ver130/contents/card1/100CANON → {"path":[".../IMG_0017.JPG", ...]}
```

- Storage is named **`card1`**, not `sd`
- Folders paginate at ~100/page via `?page=N`, **oldest first**
- To show newest first: get the count with `?kind=number` (`contentsnumber`),
  compute the last page, and page **backwards**. Paging forward from page 1 on a
  6,000-image card returns the oldest images and looks broken.

### 3.5 Download

```
GET <content-path>?kind=main       → full-resolution original
GET <content-path>?kind=thumbnail  → thumbnail (for browsing UI)
```

Retry transient failures with backoff; a burst-writing camera 503s frequently.

### 3.6 CORS — the enabler for a browser client

CCAPI exposes CORS configuration:

```
/ccapi/ver100/functions/cors/corssetting
/ccapi/ver100/functions/cors/origin
```

**This is what makes a browser client viable at all.** The camera can be told to
accept a specific web origin. Configure this before writing any fetch code, and
verify with a trivial `fetch()` from the target origin — it de-risks the whole
project. See §5.1 for the remaining blocker even with CORS configured.

### 3.7 USB — investigated, and mostly a dead end for web

Documented for completeness so it isn't re-investigated:

- **CCAPI has no USB transport whatsoever** — the word "USB" does not appear in
  the 929-page reference. Connection formats are Wi-Fi and wired LAN/WFT only,
  and the R50 has neither an Ethernet port nor WFT support.
- **EDSDK is unusable** — Windows/macOS/Linux-x64 only.
- The only wired route is **PTP over USB**, measured at **22.1 MB/s (11× Wi-Fi)**.
- Opening a PTP session cold puts the camera into **PC-connection mode**, which
  **locks the shutter**. Launching Canon Camera Connect first negotiates a mode
  where the camera stays shootable, and that mode persists after Camera Connect
  is closed, for as long as the cable stays connected.
- Replicating that handshake requires **Canon vendor PTP commands**.

For the web: **WebUSB** could theoretically do this, but you would hand-roll the
entire PTP stack (container packets, transaction IDs, request/data/response
phases) *plus* undocumented Canon vendor opcodes. Android at least provides
`MtpDevice` for free enumeration and transfer; the browser provides nothing.
**Recommend descoping USB from v1.**

---

## 4. Upload backend

Already deployed and working. The web app should use it unchanged.

**Auth:** `Authorization: Bearer <token>` on both endpoints.

```http
POST /api/presign
{ "key": "listings/IMG_0017.JPG", "contentType": "image/jpeg" }
→ 200 { "uploadUrl": "...", "publicUrl": "...", "key": "..." }
```

```http
POST /api/drafts
{ "sku": "0000646", "images": ["https://...", ...] }
→ 200 { "draftId": "..." }
```

Then `PUT` the image bytes directly to `uploadUrl` (presigned S3, 300s TTL,
`Content-Type` bound). Bytes never transit the backend.

**Two traps, both hit in production:**

1. **Endpoints live under `/api`.** The root paths are served by the frontend
   SPA; `POST /presign` returns nginx **405**.
2. **Always use `https://`.** An `http://` base 301-redirects, and fetch/OkHttp
   follow the redirect by downgrading `POST → GET`, which the API answers with
   **405 Method Not Allowed**. Force the scheme.

**Web-specific additions required:**

- The **S3 bucket needs CORS** allowing `PUT` from the app origin with the
  `Content-Type` header. (Android didn't need this; browsers do.)
- The bucket already serves `listings/*` publicly for read, so `publicUrl` is a
  stable link — no presigned GET needed.

**Upload must be idempotent per SKU.** Persist each photo's `publicUrl` as it
uploads, and build the draft from *all* uploaded photos for that SKU, so a retry
after a partial failure still produces a complete draft. Only delete local
copies after the draft is confirmed.

---

## 5. Web platform constraints — read before designing

This is where a web port diverges sharply from Android.

### 5.1 Reaching the camera — the hard blocker

The camera is a device on the local network with a private IP, serving plain
HTTP (or HTTPS with a self-signed cert). Browsers restrict this heavily:

| Problem | Effect |
|---|---|
| **Mixed content** | An `https://` page cannot `fetch()` `http://192.168.1.55:8080`. Blocked outright. |
| **Self-signed cert** | `https://192.168.1.55` fails cert validation. Requires the user to visit it once and manually accept, per browser profile. |
| **Private Network Access** | Chrome requires a public site fetching a private IP to receive `Access-Control-Allow-Private-Network: true` on a preflight. CCAPI almost certainly does not send it. |

**Consequence: the app cannot be hosted at `https://inventory.lizeld.com` and
talk to the camera.** No amount of CORS configuration fixes PNA + mixed content.

**Viable deployment options:**

| Option | How | Trade-off |
|---|---|---|
| **A. Serve from the LAN over HTTP** *(recommended)* | Small static server on the LAN; open `http://<lan-ip>:port`. Same-scheme HTTP→HTTP, no mixed content, no PNA issue. | Not "on the internet"; needs something on the LAN to serve it. Insecure context ⇒ no service workers, no Wake Lock in some browsers. |
| **B. LAN-served over HTTPS with a real cert** | Local domain + trusted cert (e.g. via internal CA or a public domain resolving to a LAN IP). Camera on HTTP still blocked — so camera must also be HTTPS, and its self-signed cert accepted once. | Fiddly; costs the HTTP speed advantage (§3.1). |
| **C. Local companion process** | Small local agent talks to the camera; browser talks to the agent. | Reintroduces a machine on the LAN — the exact thing the Android app eliminated. |

**Recommendation: Option A.** Accept that this is a LAN-served app, not a
public web app. If it must be a secure context (for service workers), Option B.

> A tablet PWA that is *installed* still runs under its origin's scheme, so this
> constraint does not go away by "installing" it.

### 5.2 Background execution

**A web app cannot poll the camera while backgrounded or closed.** There is no
equivalent of Android's foreground service. Background Sync and Periodic Sync
are throttled, unreliable, and unsuitable for a 1-second poll loop.

Mitigations:
- Use the **Screen Wake Lock API** to keep the display on during a shoot
- Design for **foreground-only operation** and make that explicit in the UI
- Recover cleanly on reopen: re-sync from the camera's contents listing, using
  the dedup key to skip already-handled photos

This is a genuine regression versus Android. Confirm it's acceptable before
committing to a web port — the original requirement was "run unattended during a
shoot".

### 5.3 Capability mapping

| Concern | Android | Web |
|---|---|---|
| Imaging | Canvas / Bitmap | `OffscreenCanvas` in a Worker + `createImageBitmap` |
| JPEG encode | `Bitmap.compress` | `canvas.convertToBlob({type:'image/jpeg', quality:0.92})` |
| Barcode | ML Kit | `BarcodeDetector` (Chrome/Android) — fall back to **zxing-wasm** |
| Persistence | Room (SQLite) | IndexedDB (metadata) + **OPFS** (image bytes) |
| Background jobs | WorkManager | In-page queue + retry; no true background |
| Notifications | System notifications | Notifications API (foreground only) |
| Camera link | OkHttp | `fetch` (subject to §5.1) |
| USB | `MtpDevice` | WebUSB — **descope** (§3.7) |

### 5.4 Memory

Photos are 24MP (6000×4000). A decoded RGBA frame is ~96 MB. Process **one at a
time**, in a Worker, and release aggressively:

- `createImageBitmap(blob)` → draw → `bitmap.close()` **explicitly**
- Reuse a single `OffscreenCanvas` rather than allocating per image
- Never hold decoded frames in an array
- Store bytes in OPFS, not in memory or IndexedDB blobs

Tablet browsers will kill the tab on sustained pressure; this is the most likely
source of hard-to-reproduce failures.

---

## 6. Recommended architecture

```
┌─ UI (foreground tab) ────────────────────────────────┐
│  Status · Gallery · Camera browser · Settings        │
└──────────────────┬───────────────────────────────────┘
                   │
┌─ Orchestrator (main thread, small) ──────────────────┐
│  poll loop · work queue · grouping reducer           │
└──────┬───────────────────────────┬───────────────────┘
       │                           │
┌─ Worker: imaging ────┐   ┌─ Storage ─────────────────┐
│ decode · watermark   │   │ IndexedDB metadata        │
│ barcode · encode     │   │ OPFS image bytes          │
└──────────────────────┘   └───────────────────────────┘
                   │
┌─ Uploader ───────────────────────────────────────────┐
│  presign → PUT to S3 → create draft → cleanup        │
└──────────────────────────────────────────────────────┘
```

### 6.1 The ingest loop

Port this design directly — it was arrived at by fixing real production failures:

1. Poll `event/polling` every ~1s
2. For each reported photo, **enqueue by DCF key**
3. **Detect sequence gaps** and enqueue the missing keys too, deriving the folder
   from the reported path itself (not from `currentdirectory`)
4. **Drain the queue in IMG-sequence order.** On a transient failure of the
   lowest-sequence item, stop draining and retry it next cycle — this guarantees
   a later SKU photo can never flush its group while an earlier frame is missing
5. Give up on an item only after ~15 cycles; drop `404`s immediately
6. **Prefetch**: start the next download before processing the current photo, so
   the network isn't idle during decode/barcode work

### 6.2 Data model (IndexedDB)

```ts
interface Photo {
  dcfKey: string;        // PRIMARY KEY — "100CANON/IMG_0017.JPG"
  sourcePath: string;    // provenance (CCAPI path)
  fileName: string;
  sequenceNumber: number | null;
  sku: string | null;
  status: 'PENDING' | 'GROUPED' | 'REVIEW' | 'UPLOADED' | 'FAILED';
  opfsPath: string | null;  // null once deleted post-upload
  publicUrl: string | null; // set on upload; draft is built from these
  createdAt: number;
  updatedAt: number;
}

interface Meta { lastSequence: number | null; }  // high-water mark
```

Index `status` and `sku`. Dedup on `dcfKey`.

---

## 7. UI

Mirror the Android app; these screens earned their keep in production.

**Status** — connection indicator; pending count as a large figure that turns
amber at 30 and red at 35, with a progress bar to the evacuate threshold;
last SKU / last photo with relative time; start/stop; **failed-upload banner
with retry** (silent upload failures cost a production run); timestamped
activity log; verbose-error toggle.

**Gallery** — thumbnail grid of photos held locally, status dot per photo,
tap to expand, **drag-to-select** with manual **Group** (enter SKU) and
**Upload** actions, and per-SKU retry. These manual paths are the recovery
mechanism when automatic grouping goes wrong — don't omit them.

**Camera browser** — browse the card, newest first (§3.4), thumbnail grid,
multi-select, download into the pipeline.

**Settings** — camera URL (with **test connection** and LAN auto-discovery),
backend URL + token (masked), watermark padding, stale thresholds, verbose
errors.

---

## 8. Testing

- **Golden-image parity (essential).** Run the original Python on a sample
  photo, save the output as a **lossless PNG**, and assert the web renderer
  matches within tolerance. Compare the *rendered bitmap*, before JPEG encoding,
  so the known 4:2:0 deviation doesn't confound it. Android achieved max channel
  diff 2/255 — hold the web port to the same bar.
- **Grouping reducer** — unit tests with synthetic streams: SKU flush, 30/35
  thresholds, gap boundaries (100 missing reported, 101 ignored), high-water
  mark not rewinding, dedup.
- **DCF key** — the same photo via different routes must produce one key.
- **Barcode regression** — photos with known SKUs, asserted end to end.
- **Camera contract** — record real CCAPI responses as fixtures and parse-test
  them offline; the shapes here were expensive to discover.

---

## 9. Risks

| Risk | Severity | Notes |
|---|---|---|
| Browser cannot reach the camera | **Blocking** | §5.1. Resolve the deployment model *first* — it determines everything else. |
| No background execution | **High** | §5.2. Foreground-only is a real regression; confirm acceptable. |
| Memory on 24MP images | **High** | §5.4. Tab kills are the likely failure mode. |
| JPEG chroma subsampling | Low | §2.1. Same deviation Android accepted. |
| CCAPI ~2 MB/s ceiling | Medium | Hardware limit; USB is not practical from a browser. |

### Before writing application code, prove these two things

1. **A `fetch()` from the intended origin reaches the camera** — CORS configured
   per §3.6, deployment model per §5.1. If this fails, no other work matters.
2. **A 24MP photo can be decoded, watermarked, and encoded** on the actual
   tablet browser without the tab dying.

Both are a day's work and together they de-risk the entire project.

---

## Appendix — reference implementation

The Android sources are the working reference:

| Concern | File |
|---|---|
| Watermark renderer | `watermark/src/main/java/com/dnr/watermark/engine/WatermarkEngine.kt` |
| Parity test | `watermark/src/test/java/com/dnr/watermark/engine/GoldenImageTest.kt` |
| Grouping reducer | `pipeline/src/main/java/com/dnr/watermark/pipeline/GroupingStateMachine.kt` |
| Identity | `pipeline/src/main/java/com/dnr/watermark/pipeline/DcfKey.kt` |
| CCAPI client | `camera/src/main/java/com/dnr/watermark/camera/CcapiClient.kt` |
| CCAPI response fixtures | `camera/src/test/java/com/dnr/watermark/camera/CcapiParsingTest.kt` |
| Ingest loop / queue / prefetch | `app/src/main/java/com/dnr/watermark/service/IngestService.kt` |
| Upload + draft + cleanup | `upload/src/main/java/com/dnr/watermark/upload/SkuUploadWorker.kt` |

Original Python (source of the parity contract): `watermark.py`, `scheduler.py`.
