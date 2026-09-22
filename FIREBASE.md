# Firebase Storage setup (product photos & payment slips)

The backend already supports two image stores, chosen by `UPLOAD_DRIVER`:

- **`local`** (default) — files are saved under `./uploads` and served at `/uploads`.
  Zero setup, great for development, but files vanish when the container restarts.
- **`firebase`** — files are uploaded to a Firebase Storage bucket and the public
  URL is stored in Postgres (`products.image_url`, `payments.slip_url`). Use this in
  production so images are permanent and served from Google's CDN.

You don't change any code — just add the Firebase package and set a few env vars.
The upload logic lives in `src/services/uploads.js`.

---

## 1. Create a Firebase project & bucket

1. Go to **https://console.firebase.google.com** → **Add project** (or reuse one).
   You can name it e.g. `kade`. Google Analytics is optional; you can skip it.
2. In the left menu open **Build → Storage** → **Get started**.
   - Choose **Start in production mode** (we set exact rules below).
   - Pick a location close to your users (e.g. `asia-south1` for Sri Lanka/India).
3. Note your **bucket name**, shown at the top of the Storage page. It looks like
   `your-project-id.appspot.com` (newer projects may show
   `your-project-id.firebasestorage.app` — use whatever the console shows).

## 2. Create a service account key

The backend needs credentials to upload.

1. Open the **Google Cloud Console** for the same project:
   **https://console.cloud.google.com** → select your project.
2. **IAM & Admin → Service Accounts → Create service account.**
   - Name: `kade-uploader`.
   - Grant it the role **Storage Admin** (or the narrower *Storage Object Admin*).
   - Create.
3. Open the new service account → **Keys → Add key → Create new key → JSON**.
   A `.json` file downloads. **Keep it secret** — never commit it.

## 3. Storage security rules

Product photos need to be **publicly readable** (customers see them), but only your
server may **write**. In the Firebase console → **Storage → Rules**, paste:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    // Anyone can view images; uploads happen only through the backend
    // service account, which bypasses these rules.
    match /{allPaths=**} {
      allow read: if true;
      allow write: if false;
    }
  }
}
```

Click **Publish**. (The backend stores each file with a Firebase **download
token** and returns a `https://firebasestorage.googleapis.com/...?alt=media&token=…`
URL that works directly — no `makePublic()` and no "uniform bucket-level access"
issues, so you can leave the bucket on its default access setting.)

## 4. Install the Firebase package

The dependency is optional and only loaded when the driver is `firebase`:

```bash
npm install firebase-admin
```

## 5. Set environment variables

| Variable | Value |
| --- | --- |
| `UPLOAD_DRIVER` | `firebase` |
| `FIREBASE_STORAGE_BUCKET` | your bucket, e.g. `kade-xxxx.appspot.com` |
| `FIREBASE_SERVICE_ACCOUNT` | the **entire** service-account JSON, on **one line** |

To turn the JSON key into a single line for the env var:

```bash
# prints the JSON with newlines escaped — copy the output
node -e "console.log(JSON.stringify(require('./your-key.json')))"
```

Paste that output as the value of `FIREBASE_SERVICE_ACCOUNT`.

> Alternative: instead of `FIREBASE_SERVICE_ACCOUNT`, you can set
> `GOOGLE_APPLICATION_CREDENTIALS` to a path of the JSON file on disk. The code
> falls back to application-default credentials when `FIREBASE_SERVICE_ACCOUNT`
> is empty.

### On Railway

- Project → your service → **Variables** → add the three variables above.
- For `FIREBASE_SERVICE_ACCOUNT`, use Railway's **Raw Editor** or paste the
  single-line JSON as the value (Railway handles the quotes fine).
- Redeploy. `firebase-admin` installs automatically because it's now in
  `package.json`.

## 6. Test it

1. Restart the backend with the new vars.
2. Log in to a store, open **Products → Add product**, drag in a photo, save.
3. The product row should show the photo, and its `image_url` in the database
   should be a `https://firebasestorage.googleapis.com/v0/b/<bucket>/o/...` URL.
4. Payment slips uploaded at registration/renewal land under `slips/` in the same
   bucket and appear on the admin **Payments** page.

You can also confirm the active driver in the deploy logs at startup:
`[uploads] driver=firebase bucket=<your-bucket>` (or a warning that it's local).

## 7. How it flows (for reference)

```
Browser (drag & drop)
   → multipart POST to the API
   → src/services/uploads.js  (UPLOAD_DRIVER === 'firebase')
   → bucket.file('products/<slug>/<timestamp>-name.jpg').save(buffer, { token })
   → returns https://firebasestorage.googleapis.com/v0/b/<bucket>/o/<path>?alt=media&token=…
   → stored in Postgres (image_url / slip_url)
```

Folders created automatically: `products/<store-slug>/…` and `slips/…`.

## 8. Cost & tips

- Firebase Storage free tier (Spark plan) includes **5 GB stored** and **1 GB/day
  download** — plenty for many small shops. Beyond that, the Blaze (pay-as-you-go)
  plan is a few cents per extra GB.
- Resize/compress large photos before upload if you expect very high volume (a
  future enhancement — the current flow stores the original).
- To roll back to local storage at any time, set `UPLOAD_DRIVER=local`; existing
  Firebase URLs keep working since they're absolute.
