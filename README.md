# 🧾 Bill Tracker

A small web app to capture bills from your phone and review them from a finance dashboard.

- **Phone page** (`/`) — pick one or more **bill types** (a chip selector — tap to select, type to add new ones), set amount/date/vendor, attach payment screenshots, save.
- **Finance dashboard** (`/dashboard.html`) — List / Table / Grouped views, filter by bill type / status / date, search, view payment proofs, mark paid/reviewed, **Copy CSV** (per group too) or Download CSV.
- Data is stored in a local **SQLite** file; screenshots are stored in `uploads/`. Both the phone and the dashboard talk to the same server, so a bill entered on the phone shows up on the dashboard instantly.
- Optional: **mirror everything live into a Google Sheet, photos included** (see below).

## Bill types

The old free-text "what kind of bill" field is gone — **bill type is now the chip selector** and is the main way you categorise. Your chosen types are saved so they're one tap next time. You can add and remove types (removing asks for confirmation). The pinned default (`3061`) always stays; change it with `DEFAULT_TAGS` in `.env`.

## Setup

```bash
npm install
cp .env.example .env      # then edit the passwords inside .env
npm start
```

Open **http://localhost:3000** on this computer.

> On Windows PowerShell use `copy .env.example .env` instead of `cp`.

## Passwords

Set these in `.env`:

| Variable           | Used for                                              |
|--------------------|-------------------------------------------------------|
| `ENTRY_PASSWORD`   | Adding bills (the phone interface)                    |
| `FINANCE_PASSWORD` | The finance dashboard (also allowed to add bills)     |
| `SESSION_SECRET`   | Signs login cookies — set to a long random string     |
| `CURRENCY`         | Currency symbol shown in the UI (default `₹`)         |

If you don't create a `.env`, it falls back to `bills123` / `finance123` — fine for testing, **change before sharing**.

## Using it from your phone

Both your phone and computer must be on the same Wi-Fi.

1. Find your computer's local IP (e.g. `192.168.1.20`):
   - Windows: run `ipconfig` and look for *IPv4 Address*.
2. On your phone's browser, go to `http://<that-ip>:3000`.
3. Log in with the entry password and add bills. Use "Add to Home Screen" for an app-like icon.

The finance person opens `http://<that-ip>:3000/dashboard.html` with the finance password.

### Putting it online
To use it outside your home Wi-Fi, deploy the folder to any Node host (Render, Railway, a small VPS). Set the same environment variables there. Because uploads are saved to disk, pick a host with a persistent disk (or move uploads to cloud storage later).

## Live Google Sheet mirror (optional, with photos)

This pushes every saved bill into a Google Sheet so the finance person can just watch the sheet — each row includes the bill details, an inline photo preview, and a link to open the full image. It's one-way (app → sheet) and completely optional.

It uses a **Google Apps Script web app** so there's **no Google Cloud project or API keys** to set up.

1. Create (or open) the Google Sheet you want the bills in.
2. In that sheet: **Extensions ▸ Apps Script**. Delete any sample code, then paste the entire contents of [`google-apps-script.gs`](google-apps-script.gs). Save.
3. In the Apps Script editor: **Project Settings (⚙) ▸ Script properties ▸ Add script property**
   - Property: `SECRET`  Value: pick any password, e.g. `my-secret-123`
4. **Deploy ▸ New deployment ▸** type **Web app**.
   - *Execute as:* **Me**
   - *Who has access:* **Anyone**
   - Click **Deploy**, authorise when prompted, and **copy the Web app URL** (ends in `/exec`).
5. In the app's `.env`, set:
   ```
   SHEETS_WEBHOOK_URL=https://script.google.com/macros/s/XXXX/exec
   SHEETS_WEBHOOK_SECRET=my-secret-123
   ```
6. Restart the app (`npm start`). The startup banner should say `Google Sheet sync: ON`. Add a bill and watch a row appear in the sheet.

Notes:
- The script saves photos into a Drive folder called **"Bill Tracker Photos"** (in the Google account that owns the sheet) and shows them inline via `=IMAGE(...)`. If a thumbnail ever looks blank, the **Proof** link in that row still opens the full image.
- If you change the script later, do **Deploy ▸ Manage deployments ▸ Edit ▸ New version** so the URL keeps working.
- Status changes and deletions in the dashboard update/remove the matching row too.

## Data & backup

- `data.db` — the SQLite database (all bills, tags, statuses).
- `uploads/` — the attached screenshots/PDFs.

Back these two up together. Deleting a bill from the dashboard also deletes its files.

## Tech

Node + Express + better-sqlite3 + multer. No build step — plain HTML/CSS/JS in `public/`.
