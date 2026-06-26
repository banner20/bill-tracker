# 🧾 Bill Tracker

A small web app to capture bills from your phone and review them from a finance dashboard.

- **Phone page** (`/`) — pick one or more **bill types** (a chip selector — tap to select, type to add new ones), set amount/date/vendor, attach payment screenshots, save.
- **Finance dashboard** (`/dashboard.html`) — List / Table / Grouped views, filter by bill type / status / date, search, view payment proofs, mark paid/reviewed, **Copy CSV** (per group too) or Download CSV.
- Optional: **mirror everything live into a Google Sheet, photos included**.

## Architecture (cloud, stateless)

| Concern        | Service                          |
|----------------|----------------------------------|
| App / API      | Express (Node) — runs on Vercel  |
| Database       | **Supabase** (Postgres)          |
| Photo storage  | **Cloudinary**                   |
| Live mirror    | Google Sheet via Apps Script (optional) |

The server keeps no local state, so it deploys to Vercel (or Render/Railway) cleanly.

## Bill types

Bill type is the chip selector and is the main way you categorise. Your chosen types are saved so they're one tap next time. You can add and remove types (removing asks for confirmation). The pinned default (`3061`) always stays; change it with `DEFAULT_TAGS`.

---

## 1. Create the two cloud accounts

### Supabase (database)
1. Create a project at [supabase.com](https://supabase.com).
2. **Project Settings ▸ Database ▸ Connection string ▸ URI**. Choose the **Transaction pooler** option (host looks like `...pooler.supabase.com`, port `6543`).
3. Copy it, put in your DB password, and make sure it ends with `?sslmode=require`. This is your `DATABASE_URL`. (Tables are created automatically on first run.)

### Cloudinary (photos)
1. Create an account at [cloudinary.com](https://cloudinary.com).
2. On the dashboard, copy the **`CLOUDINARY_URL`** (`cloudinary://API_KEY:API_SECRET@CLOUD_NAME`).

## 2. Run locally (optional)

```bash
npm install
cp .env.example .env     # Windows: copy .env.example .env
# edit .env: paste DATABASE_URL and CLOUDINARY_URL, set passwords + SESSION_SECRET
npm start
```
Open http://localhost:3000.

## 3. Deploy to Vercel

1. Push to GitHub (already done: `github.com/banner20/bill-tracker`).
2. On [vercel.com](https://vercel.com) ▸ **Add New ▸ Project** ▸ import the repo.
3. Add these **Environment Variables** (Project Settings ▸ Environment Variables):

   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | your Supabase transaction-pooler URI |
   | `CLOUDINARY_URL` | your Cloudinary URL |
   | `SESSION_SECRET` | a long random string |
   | `ENTRY_PASSWORD` | password for adding bills |
   | `FINANCE_PASSWORD` | password for the dashboard |
   | `DEFAULT_TAGS` | e.g. `3061` |
   | `SHEETS_WEBHOOK_URL` | (optional) your Apps Script `/exec` URL |
   | `SHEETS_WEBHOOK_SECRET` | (optional) must match the Apps Script `SECRET` |

4. **Deploy.** Vercel gives you a `https://your-app.vercel.app` URL — open it on your phone, log in, add a bill.

`vercel.json` routes every request to the Express app and bundles the `public/` frontend.

---

## Live Google Sheet mirror (optional, with photos)

Pushes every saved bill into a Google Sheet so finance can just watch the sheet — each row has the bill details, an inline photo preview (from Cloudinary), and a link to open the full image. One-way (app → sheet). No Google Cloud project needed.

1. Open (or create) the Google Sheet you want the bills in.
2. **Extensions ▸ Apps Script**. Delete the sample code, paste all of [`google-apps-script.gs`](google-apps-script.gs), save.
3. **Project Settings (⚙) ▸ Script properties ▸ Add**: `SECRET` = any password.
4. **Deploy ▸ New deployment ▸ Web app**: *Execute as* **Me**, *Who has access* **Anyone** ▸ **Deploy**, authorise, and copy the **`/exec`** URL.
5. Set `SHEETS_WEBHOOK_URL` (the `/exec` URL) and `SHEETS_WEBHOOK_SECRET` (same as the `SECRET` above) — in `.env` locally and/or in Vercel env vars. Redeploy/restart.

> Important: "Who has access" **must** be **Anyone**, or the server gets a 401 and can't write to the sheet. If you edit the script later, use **Deploy ▸ Manage deployments ▸ Edit ▸ New version** so the URL keeps working.

## Passwords & access

`ENTRY_PASSWORD` lets someone add bills; `FINANCE_PASSWORD` also unlocks the dashboard. Logins are signed HTTP-only cookies (30 days). Change the defaults before sharing.

## Tech

Node + Express + `pg` (Postgres/Supabase) + Supabase Storage. Plain HTML/CSS/JS frontend in `public/`, no build step.
