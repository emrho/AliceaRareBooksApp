# Alicea Rare Books — Shop Manager

A small web app for a home book business that sells on **eBay, Whatnot and Amazon**. Everyone signs in to a home screen of app cards, one per tool:

- **eBay Listing Tool**: photograph a book with a phone or upload pictures. AI (Claude) reads the cover and fills in the title, author, edition, condition, an eBay title, a description and a suggested price. Check the details, then list it on eBay in one tap. The photos double as inventory thumbnails.

- **Inventory**: every book with its SKU, condition, shelf location, cost, asking price, and which platforms it's listed on (with listing IDs).
- **Sales**: record a sale from any channel. Stock drops automatically, and the platform fees, postage and cost of the book are tracked so you see real profit. If the last copy sells while it's still listed on another site, the app reminds you to end those listings so the book can't sell twice.
- **Expenses**: postage, supplies, inventory buys, subscriptions and so on, sorted into categories you can change.
- **Time clock**: employees sign in on any phone or computer and tap *Clock in* / *Clock out*.
- **Hours & pay**: weekly hours per employee by day, regular and overtime hours, rate and gross pay. You can export it to CSV or print it, and you can fix or add shifts.
- **Owner dashboard**: net profit, gross sales, expenses, labor and fees for any date range. It also shows weekly sales by channel, a profit & loss breakdown, each employee's hours/rate/pay this week (and who's on the clock right now), inventory value, and a list of books that need delisting.

Owners see everything. Employees see the **eBay Listing Tool**, **Timeclock** and **Inventory**; from Inventory they can add or edit books and record sales.

The top bar has a **Light/Dark** switch, **Lock** (hides the screen on a shared computer until the password is entered; the time clock keeps running) and **Sign Out**. On a phone, use the browser's "Add to Home Screen" to install it like an app.

**Google Sheets:** inventory, sales and expenses can be kept in sync with your own Google Sheet in both directions. See [Google Sheets (two-way sync)](#google-sheets-two-way-sync).

## Running it

You need [Node.js](https://nodejs.org) 22.13 or newer. There are no other dependencies to install: the database is SQLite, which is built into Node.

```bash
npm install
npm start
```

Open http://localhost:3000. On first visit you'll create the owner account. Then go to **Team** to add employees and their hourly rates.

To try it with sample data first (only on an empty database):

```bash
npm run seed     # owner / changeme123, employees jordan & sam (same password)
npm start
```

To start over, delete the `data/` folder.

### Settings

| Environment variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind to (`0.0.0.0` lets phones on your Wi-Fi reach it) |
| `DB_PATH` | `./data/books.db` | Where the database file lives |
| `TZ` | system zone | Time zone for the clock, e.g. `America/New_York` |
| `TRUST_PROXY` | unset | Set to `1` when running behind an HTTPS reverse proxy |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | unset | Path to a Google service account JSON key; needed for two-way sync (and for reading private sheets) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | unset | The same key's contents, instead of a file path |
| `ANTHROPIC_API_KEY` | unset | Turns on AI book identification in the eBay Listing Tool |
| `EBAY_CLIENT_ID` / `EBAY_CLIENT_SECRET` / `EBAY_RU_NAME` | unset | eBay developer keys for listing on eBay |
| `EBAY_ENV` | production | Set to `sandbox` to test against eBay's sandbox |

In the app, **Settings** controls the business name, which day the pay week starts on, overtime rules (default: over 40 hrs/week at 1.5×) and the expense categories.

### Using it from phones

Run it on a computer at home and have employees open `http://<that-computer's-IP>:3000` while they're on the same Wi-Fi. If you want access from outside the house, put it behind HTTPS (for example a Tailscale, Cloudflare Tunnel or Caddy setup). Don't expose plain HTTP to the internet.

### Backups

Everything lives in the `data/` folder: the database `books.db` and book photos in `photos/`. Copy the whole folder somewhere safe regularly. The CSV exports (Inventory, Sales, Expenses, Hours & Pay) also work well for your accountant.

## Google Sheets (two-way sync)

Inventory, sales and expenses can live in your Google Sheet. The app reads the sheet and, with **two-way sync**, writes back every change made in the app: new books, edits, sales, stock counts after a sale, eBay listing IDs, and expenses. You can link any of the three sections on their own.

### Setup (about 15 minutes, once)

**1. Create a Google service account** (a "robot" Google login the app uses). This is required for the app to write to the sheet.

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project (any name, e.g. "Alicea Rare Books").
2. Go to **APIs & Services → Library**, search for **Google Sheets API**, and click **Enable**.
3. Go to **APIs & Services → Credentials → Create credentials → Service account**. Give it a name and click **Done** (it doesn't need any roles).
4. Open the new service account, go to **Keys → Add key → Create new key → JSON**, and save the downloaded file somewhere private on the computer that runs the app.
5. Start the app with the key:
   ```bash
   GOOGLE_SERVICE_ACCOUNT_FILE=/path/to/key.json npm start
   ```
   (or put the file's contents in the `GOOGLE_SERVICE_ACCOUNT_JSON` variable). **Settings → Google Sheets** now shows the service account's email, which looks like `name@project.iam.gserviceaccount.com`.

Keep the key file private, and don't commit it to git.

**2. Prepare the spreadsheet**

- Use your existing sheet, or create one with three tabs: **Inventory**, **Sales** and **Expenses**.
- Each tab needs **column headings in row 1**. The app recognizes common names, so exact wording doesn't matter, and extra columns are ignored:

  | Tab | Required | Also understood |
  |---|---|---|
  | Inventory | Title | SKU / Item #, Author, ISBN, Publisher, Year, Edition, Binding, Condition, Shelf / Location, Qty, Cost / Paid, Price / Asking Price, Acquired, Source, eBay, Whatnot, Amazon / ASIN, Listed On, Status, Description, Notes |
  | Sales | Date, Sale Price / Sold For | Platform / Channel, SKU, Title, Qty, Shipping Charged, Fees, Postage / Shipping / Label, Cost, Order #, Notes, App ID |
  | Expenses | Date, Amount | Category, Vendor / Payee, Notes / Description, App ID |

- With two-way sync on, **a blank tab is fine**: the app writes the headings itself.
- Click **Share** in Google Sheets and add the service account's email as an **Editor**. Viewer access only allows reading.

**3. Link it in the app**

1. Open **Settings → Google Sheets** (the card has these same steps under *How to set it up*).
2. For each tab, open it in your browser, copy the address bar (it ends in `#gid=…`), and paste it into the matching box.
3. Tick **Two-way sync** and click **Save & sync**. The app shows how many rows it read, which columns it used, and any rows it skipped (for example, a row with an unreadable date).
4. If you already entered books, sales or expenses in the app before linking, the card offers **Copy them into the sheet**, so everything ends up in one place.

### How syncing works

- **App → sheet:** a change in the app is written to the sheet within a couple of seconds. Only the cells that changed are updated, so your other columns, formatting, formulas and notes are left alone.
  - The app adds a **SKU** column to Inventory and an **App ID** column to Sales and Expenses if they're missing. These are how it finds the right row again even after you sort or insert rows, so don't edit them.
  - If Google can't be reached, changes wait (the app shows "N changes waiting") and are sent on the next sync.
- **Sheet → app:** the app re-reads the sheet automatically (every 15 minutes by default; adjustable) and whenever you click **Sync now**. A row that still has unsent app changes is never overwritten by the sheet.
- **Columns the app doesn't need:** on books, the app only takes values from columns the sheet actually has. For example, if the sheet has no Shelf column, the shelf typed in the app is kept.
- **Deletes:** deleting a sale, expense or book in the app deletes its row in the sheet. Deleting a row in the sheet removes it from the app at the next sync.
- **What stays in the app:** time tracking, pay and photos are never written to the sheet.
- **Without a service account:** the app can only *read*. Share the sheet as *Anyone with the link can view*; linked sections are then view-only in the app, and you make changes in the sheet.

## eBay Listing Tool

### 1. Turn on the AI

The AI step uses Claude (model `claude-opus-5-5`). Create an API key at [console.anthropic.com](https://console.anthropic.com/) and start the server with it:

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Each "Fill in details with AI" sends the photos (up to 6, resized to 1600px) and usually costs a few cents. The AI only claims edition, printing or signature details the photos support. It lists anything you should double-check under **Check before listing**, and the suggested price is an estimate; use the *Check sold listings on eBay* link to confirm it.

### 2. Connect eBay

Listings are created through eBay's official Sell APIs (Inventory, Account and Media).

1. Sign up at [developer.ebay.com](https://developer.ebay.com/) and create an application keyset (start with **Sandbox** to test, then **Production**). Note the **App ID (Client ID)** and **Cert ID (Client Secret)**.
2. Under **User Tokens → Get a Token from eBay via Your Application**, add an eBay redirect URL. Set **Your auth accepted URL** to `https://<your-app-address>/api/ebay/callback` and copy the generated **RuName**.
   - eBay requires HTTPS here, so the app needs to be reachable over HTTPS at that address (for example through Tailscale Funnel, a Cloudflare Tunnel or Caddy). See *Using it from phones* above.
3. In eBay Seller Hub, turn on **Business policies** (Account → Business policies) and create at least one shipping, payment and return policy.
4. Start the server with the keys:
   ```bash
   EBAY_CLIENT_ID=... EBAY_CLIENT_SECRET=... EBAY_RU_NAME=... npm start   # add EBAY_ENV=sandbox while testing
   ```
5. As the owner, open **Settings → eBay → Connect eBay account**, sign in on eBay, and approve access. Back in the app, choose the shipping, payment and return policies and a ship-from location (you can add one there), then click **Save**.

### 3. List a book

1. Open **eBay Listing Tool**. Tap **Take photo** for the cover; add the spine, the copyright page and any flaws if you like.
2. Tap **✨ Fill in details with AI**, then review every field.
3. Tap **Save & list on eBay**. The book is added to inventory with its photos, the listing goes live, and you get a **View on eBay** link.
   - **Save to inventory** keeps it as a draft for later. Any in-stock book can also be listed from its Inventory card with **List on eBay**.

Listing details:
- **Category:** *Books* (261186) or *Antiquarian & Collectible* (29223). The AI suggests Collectible for true firsts, signed copies and older scarce books.
- **Condition:** shown with eBay's book conditions (Like New, Very Good, Good, Acceptable), mapped from booksellers' grades.
- **Item specifics:** Book Title, Author, Language, Publisher, Year, Format, Edition and Signed are sent automatically.
- **When the last copy sells elsewhere,** the app offers to end the eBay listing for you so it can't sell twice. **End eBay listing** on a book's card does the same.
- **Inventory from a Google Sheet:** with two-way sync on, books listed here (and their eBay listing IDs) are written to your sheet automatically. In read-only mode, the app gives you a row to paste into the sheet instead.

## How the numbers work

- **Profit on a sale** = item price + shipping charged − platform fees − postage you paid − what you paid for the book.
- **Net profit** = profit on sales − business expenses − employee pay.
- **Pay** comes from completed shifts: (clock-out − clock-in − unpaid break) × the rate in effect when the shift was worked. A shift belongs to the week it started in. Hours past the weekly overtime threshold are paid at the multiplier. Pay figures are gross, before taxes and withholding.

## Development

```bash
npm run dev   # restarts on file changes
npm test      # API, payroll, Sheets, AI and eBay tests (eBay and the AI are faked; no keys needed)
```

- `server/`: Express API (`app.js`), database schema (`db.js`), auth (`auth.js`), time and pay math (`payroll.js`), Google Sheets import (`sheets.js`) and write-back (`sheets-writer.js`), AI book identification (`ai.js`), eBay integration (`ebay.js`)
- `public/`: the browser app (plain HTML/CSS/JS, no build step)
- `test/`: tests run with Node's built-in test runner
