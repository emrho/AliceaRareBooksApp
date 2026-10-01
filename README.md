# Alicea Rare Books — Shop Manager

A small web app for a home book business that sells on **eBay, Whatnot and Amazon**. It handles:

- **Inventory**: every book with its SKU, condition, shelf location, cost, asking price, and which platforms it's listed on (with listing IDs).
- **Sales**: record a sale from any channel. Stock drops automatically, and the platform fees, postage and cost of the book are tracked so you see real profit. If the last copy sells while it's still listed on another site, the app reminds you to end those listings so the book can't sell twice.
- **Expenses**: postage, supplies, inventory buys, subscriptions and so on, sorted into categories you can change.
- **Time clock**: employees sign in on any phone or computer and tap *Clock in* / *Clock out*.
- **Hours & pay**: weekly hours per employee by day, regular and overtime hours, rate and gross pay. You can export it to CSV or print it, and you can fix or add shifts.
- **Owner dashboard**: net profit, gross sales, expenses, labor and fees for any date range. It also shows weekly sales by channel, a profit & loss breakdown, each employee's hours/rate/pay this week (and who's on the clock right now), inventory value, and a list of books that need delisting.

Owners see everything. Employees see only the **Time Clock** and **Inventory** pages; from Inventory they can add or edit books and record sales.

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

In the app, **Settings** controls the business name, which day the pay week starts on, overtime rules (default: over 40 hrs/week at 1.5×) and the expense categories.

### Using it from phones

Run it on a computer at home and have employees open `http://<that-computer's-IP>:3000` while they're on the same Wi-Fi. If you want access from outside the house, put it behind HTTPS (for example a Tailscale, Cloudflare Tunnel or Caddy setup). Don't expose plain HTTP to the internet.

### Backups

Everything lives in one file, `data/books.db`. Copy it somewhere safe regularly. The CSV exports (Inventory, Sales, Expenses, Hours & Pay) also work well for your accountant.

## How the numbers work

- **Profit on a sale** = item price + shipping charged − platform fees − postage you paid − what you paid for the book.
- **Net profit** = profit on sales − business expenses − employee pay.
- **Pay** comes from completed shifts: (clock-out − clock-in − unpaid break) × the rate in effect when the shift was worked. A shift belongs to the week it started in. Hours past the weekly overtime threshold are paid at the multiplier. Pay figures are gross, before taxes and withholding.

## Development

```bash
npm run dev   # restarts on file changes
npm test      # API and payroll tests
```

- `server/`: Express API (`app.js`), database schema (`db.js`), auth (`auth.js`), time and pay math (`payroll.js`)
- `public/`: the browser app (plain HTML/CSS/JS, no build step)
- `test/`: tests run with Node's built-in test runner
