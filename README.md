# Alicea Rare Books — Shop Manager

A small web app for a home book business that sells on **eBay, Whatnot and Amazon**. It handles:

- **Inventory**: every book with its SKU, condition, shelf location, cost, asking price, and which platforms it's listed on (with listing IDs).
- **Sales**: record a sale from any channel. Stock drops automatically, and the platform fees, postage and cost of the book are tracked so you see real profit. If the last copy sells while it's still listed on another site, the app reminds you to end those listings so the book can't sell twice.
- **Expenses**: postage, supplies, inventory buys, subscriptions and so on, sorted into categories you can change.
- **Time clock**: employees sign in on any phone or computer and tap *Clock in* / *Clock out*.
- **Hours & pay**: weekly hours per employee by day, regular and overtime hours, rate and gross pay. You can export it to CSV or print it, and you can fix or add shifts.
- **Owner dashboard**: net profit, gross sales, expenses, labor and fees for any date range. It also shows weekly sales by channel, a profit & loss breakdown, each employee's hours/rate/pay this week (and who's on the clock right now), inventory value, and a list of books that need delisting.

Owners see everything. Employees see only the **Time Clock** and **Inventory** pages; from Inventory they can add or edit books and record sales.

**Google Sheets:** inventory, sales and expenses can be read from your own Google Sheet instead of being typed into the app. See [Reading from Google Sheets](#reading-from-google-sheets).

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
| `GOOGLE_SERVICE_ACCOUNT_FILE` | unset | Path to a Google service account JSON key, for reading private sheets |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | unset | The same key's contents, instead of a file path |

In the app, **Settings** controls the business name, which day the pay week starts on, overtime rules (default: over 40 hrs/week at 1.5×) and the expense categories.

### Using it from phones

Run it on a computer at home and have employees open `http://<that-computer's-IP>:3000` while they're on the same Wi-Fi. If you want access from outside the house, put it behind HTTPS (for example a Tailscale, Cloudflare Tunnel or Caddy setup). Don't expose plain HTTP to the internet.

### Backups

Everything lives in one file, `data/books.db`. Copy it somewhere safe regularly. The CSV exports (Inventory, Sales, Expenses, Hours & Pay) also work well for your accountant.

## Reading from Google Sheets

If you already keep your books, sales and expenses in a Google Sheet, the app can read them from it. You can link any of the three sections on their own.

1. Put each section on its own tab, with **column headings in the first row**. The app recognizes common heading names (exact names don't matter, and extra columns are ignored):

   | Tab | Required | Also understood |
   |---|---|---|
   | Inventory | Title | SKU / Item #, Author, ISBN, Publisher, Year, Edition, Binding, Condition, Shelf / Location, Qty, Cost / Paid, Price / Asking Price, Acquired, Source, eBay, Whatnot, Amazon / ASIN, Listed On, Status, Notes |
   | Sales | Date, Sale Price / Sold For | Platform / Channel, SKU, Title, Qty, Shipping Charged, Fees, Postage / Shipping / Label, Cost, Order #, Notes |
   | Expenses | Date, Amount | Category, Vendor / Payee, Notes / Description |

   - Platform columns (eBay, Whatnot, Amazon) count as "listed" when they hold anything other than blank, "no" or "0". A listing ID or link gets saved as the listing reference.
   - A sales row is matched to a book by SKU, or by title if only one book has that title. That's how the book's cost gets filled in when the row has no Cost.
   - A plain **Shipping** column is read as the postage *you* paid. Use **Shipping Charged** for what the buyer paid.
2. In the app, go to **Settings → Google Sheets**. Open each tab in your browser, copy the address bar (it ends in `#gid=…`), paste it into the matching box, and click **Save & sync**.
3. The app shows how many rows it imported, which columns it used, and which rows it skipped and why (for example, a row with an unreadable date).

After that it re-reads the sheet automatically (every 15 minutes by default; you can change this) and whenever you click **Sync now**. The sheet is the source of truth for linked sections: add or change those records in the sheet, not in the app. Time tracking and pay always stay in the app.

### Giving the app access to the sheet

**Simple:** share the sheet as *Anyone with the link can view*. Anyone who gets the link can see it.

**Private (recommended for financial data):** use a Google service account. It acts like a robot Google user that only sees sheets you share with it.

1. Go to [Google Cloud Console](https://console.cloud.google.com/). Create a project and turn on the **Google Sheets API** under *APIs & Services → Library*.
2. Under *APIs & Services → Credentials*, choose *Create credentials → Service account*. Open the new account, go to *Keys → Add key → JSON*, and download the file.
3. Start the app with the key file:
   ```bash
   GOOGLE_SERVICE_ACCOUNT_FILE=/path/to/key.json npm start
   ```
   (or put the file's contents in `GOOGLE_SERVICE_ACCOUNT_JSON`).
4. **Settings → Google Sheets** now shows the account's email (`…@….iam.gserviceaccount.com`). Share your sheet with that email as a **Viewer**.

Keep the key file private, and don't commit it to git.

## How the numbers work

- **Profit on a sale** = item price + shipping charged − platform fees − postage you paid − what you paid for the book.
- **Net profit** = profit on sales − business expenses − employee pay.
- **Pay** comes from completed shifts: (clock-out − clock-in − unpaid break) × the rate in effect when the shift was worked. A shift belongs to the week it started in. Hours past the weekly overtime threshold are paid at the multiplier. Pay figures are gross, before taxes and withholding.

## Development

```bash
npm run dev   # restarts on file changes
npm test      # API and payroll tests
```

- `server/`: Express API (`app.js`), database schema (`db.js`), auth (`auth.js`), time and pay math (`payroll.js`), Google Sheets import (`sheets.js`)
- `public/`: the browser app (plain HTML/CSS/JS, no build step)
- `test/`: tests run with Node's built-in test runner
