// Fills an EMPTY database with realistic demo data so you can explore the app.
// Usage: npm run seed   (refuses to run if any users already exist)
import { openDb } from './db.js';
import { hashPassword } from './auth.js';
import { addDays, todayLocal, weekStartOf } from './payroll.js';

const db = openDb();
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
  console.error('The database already has users; seeding is only for a fresh install.');
  process.exit(1);
}

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => Math.round(lo + rand() * (hi - lo));

const owner = db.prepare(`INSERT INTO users (name, username, password_hash, role) VALUES ('Owner', 'owner', ?, 'owner')`)
  .run(hashPassword('changeme123')).lastInsertRowid;
const staff = [
  ['Jordan Lee', 'jordan', 1800],
  ['Sam Rivera', 'sam', 1650],
].map(([name, username, rate]) => ({
  id: db.prepare(`INSERT INTO users (name, username, password_hash, role, hourly_rate_cents) VALUES (?, ?, ?, 'employee', ?)`)
    .run(name, username, hashPassword('changeme123'), rate).lastInsertRowid,
  rate,
}));

const titles = [
  ['The Great Gatsby', 'F. Scott Fitzgerald', 'Scribner', '1953'], ['To Kill a Mockingbird', 'Harper Lee', 'Lippincott', '1960'],
  ['Dune', 'Frank Herbert', 'Chilton', '1965'], ['The Hobbit', 'J.R.R. Tolkien', 'Houghton Mifflin', '1966'],
  ['Beloved', 'Toni Morrison', 'Knopf', '1987'], ['Slaughterhouse-Five', 'Kurt Vonnegut', 'Delacorte', '1969'],
  ['The Bell Jar', 'Sylvia Plath', 'Harper & Row', '1971'], ['Invisible Man', 'Ralph Ellison', 'Random House', '1952'],
  ['Catch-22', 'Joseph Heller', 'Simon & Schuster', '1961'], ['One Hundred Years of Solitude', 'Gabriel García Márquez', 'Harper & Row', '1970'],
  ['The Joy of Cooking', 'Irma S. Rombauer', 'Bobbs-Merrill', '1964'], ['Where the Wild Things Are', 'Maurice Sendak', 'Harper & Row', '1963'],
  ['A Wrinkle in Time', "Madeleine L'Engle", 'Farrar, Straus', '1962'], ['The Left Hand of Darkness', 'Ursula K. Le Guin', 'Ace', '1969'],
  ['Things Fall Apart', 'Chinua Achebe', 'McDowell, Obolensky', '1959'], ['Charlotte\'s Web', 'E.B. White', 'Harper', '1952'],
  ['Fahrenheit 451', 'Ray Bradbury', 'Ballantine', '1953'], ['The Color Purple', 'Alice Walker', 'Harcourt', '1982'],
  ['Lonesome Dove', 'Larry McMurtry', 'Simon & Schuster', '1985'], ['The Shining', 'Stephen King', 'Doubleday', '1977'],
  ['Watership Down', 'Richard Adams', 'Macmillan', '1974'], ['The Secret History', 'Donna Tartt', 'Knopf', '1992'],
  ['Blood Meridian', 'Cormac McCarthy', 'Random House', '1985'], ['Goodnight Moon', 'Margaret Wise Brown', 'Harper', '1947'],
];
const conditions = ['Fine', 'Near Fine', 'Very Good', 'Good', 'Fair'];
const bindings = ['Hardcover', 'Hardcover w/ DJ', 'Paperback', 'Mass Market'];
const today = todayLocal();

const insBook = db.prepare(`INSERT INTO books (sku, title, author, publisher, pub_year, edition, binding, condition, location, quantity,
  cost_cents, list_price_cents, acquired_date, source, ebay_listed, ebay_ref, whatnot_listed, amazon_listed, amazon_ref)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const books = [...titles, ...titles, ...titles].map(([title, author, publisher, year], i) => {
  const cost = between(200, 4000);
  const qty = rand() < 0.2 ? between(2, 4) : 1;
  const ebay = rand() < 0.75 ? 1 : 0;
  const amazon = rand() < 0.45 ? 1 : 0;
  const id = insBook.run(`ARB-${String(i + 1).padStart(5, '0')}`, title, author, publisher, year, pick(['1st Edition', 'Book Club', 'Later Printing', '1st Thus']),
    pick(bindings), pick(conditions), `Shelf ${pick('ABCD')}${between(1, 6)}`, qty, cost, Math.round(cost * (2 + rand() * 3) / 100) * 100 - 1,
    addDays(today, -between(20, 200)), pick(['Estate sale', 'Library sale', 'Thrift store', 'Auction lot']),
    ebay, ebay ? String(between(1e11, 4e11)) : '', rand() < 0.4 ? 1 : 0, amazon, amazon ? `ARB${i + 1}` : '').lastInsertRowid;
  return { id, title, cost, qty };
});

const feeRate = { ebay: 0.1325, whatnot: 0.089, amazon: 0.15, other: 0 };
const insSale = db.prepare(`INSERT INTO sales (book_id, title, channel, sale_date, quantity, sale_price_cents, shipping_charged_cents,
  platform_fees_cents, shipping_cost_cents, cost_cents, order_ref, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
for (let d = 59; d >= 0; d--) {
  const n = rand() < 0.3 ? 0 : between(1, 3);
  for (let k = 0; k < n; k++) {
    const book = pick(books);
    if (book.qty < 1) continue;
    book.qty -= 1;
    db.prepare('UPDATE books SET quantity = quantity - 1 WHERE id = ?').run(book.id);
    // Most sold-out books get delisted right away; a few are left for the "needs delisting" list.
    if (book.qty === 0 && rand() < 0.85) db.prepare('UPDATE books SET ebay_listed = 0, whatnot_listed = 0, amazon_listed = 0 WHERE id = ?').run(book.id);
    const channel = pick(['ebay', 'ebay', 'ebay', 'whatnot', 'whatnot', 'amazon', 'amazon', 'other']);
    const price = Math.round(book.cost * (2.5 + rand() * 3.5));
    const ship = channel === 'other' ? 0 : pick([0, 499, 599]);
    insSale.run(book.id, book.title, channel, addDays(today, -d), 1, price, ship, Math.round((price + ship) * feeRate[channel]),
      channel === 'other' ? 0 : between(399, 899), book.cost, `${channel.toUpperCase().slice(0, 2)}-${between(10000, 99999)}`, owner);
  }
}

const insExp = db.prepare(`INSERT INTO expenses (expense_date, category, vendor, amount_cents, notes, created_by) VALUES (?,?,?,?,?,?)`);
for (let w = 0; w < 9; w++) {
  const base = addDays(today, -w * 7);
  insExp.run(addDays(base, -1), 'Postage', 'USPS', between(3000, 9000), '', owner);
  if (w % 2 === 0) insExp.run(addDays(base, -3), 'Inventory purchases', pick(['Estate sale', 'Library sale', 'Goodwill']), between(4000, 25000), 'Book lot', owner);
  if (w % 3 === 0) insExp.run(addDays(base, -4), 'Shipping supplies', 'Uline', between(2500, 7000), 'Mailers & bubble wrap', owner);
  if (w % 4 === 0) insExp.run(addDays(base, -2), 'Platform subscriptions', 'eBay Store', 2795, 'Basic store', owner);
}

const insTime = db.prepare(`INSERT INTO time_entries (user_id, clock_in, clock_out, break_minutes, hourly_rate_cents) VALUES (?,?,?,?,?)`);
const thisWeek = weekStartOf(today, 1);
for (let d = 41; d >= 1; d--) {
  const day = addDays(today, -d);
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  if (dow === 0) continue;
  for (const s of staff) {
    if (rand() < 0.25 || (dow === 6 && rand() < 0.6)) continue;
    const start = between(8, 10);
    const len = between(5, 9);
    insTime.run(s.id, `${day}T${String(start).padStart(2, '0')}:${pick(['00', '15', '30'])}`,
      `${day}T${String(start + len).padStart(2, '0')}:${pick(['00', '15', '45'])}`, len >= 6 ? 30 : 0, s.rate);
  }
}
// Leave one person on the clock today so the dashboard shows a live shift.
if (today >= thisWeek) insTime.run(staff[0].id, `${today}T09:00`, null, 0, staff[0].rate);

console.log('Demo data added. Sign in as owner / changeme123 (employees: jordan, sam — same password).');
console.log('Change these passwords on the Team page before using the app for real.');
