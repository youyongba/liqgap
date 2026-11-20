'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
// pkg deployments load the target-platform native addon from the external node_modules.
const Database = process.pkg
  ? require(path.join(process.cwd(), 'node_modules', 'better-sqlite3'))
  : require('better-sqlite3');

function createStore(filename = process.env.PAYMENT_DB_PATH || path.join(process.cwd(), 'data', 'payments.sqlite')) {
  if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, keyHash TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL, amount TEXT NOT NULL, duration INTEGER NOT NULL,
      createdAt INTEGER NOT NULL, expiresAt INTEGER, revokedAt INTEGER,
      state TEXT NOT NULL DEFAULT 'new', wallet TEXT,
      paymentKey TEXT UNIQUE, payload TEXT, fromBlock TEXT, txHash TEXT UNIQUE, error TEXT
    );
  `);
  if (filename !== ':memory:') fs.chmodSync(filename, 0o600);
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const get = id => db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  function create(type, amount, duration, admin = false) {
    const id = crypto.randomBytes(16).toString('hex');
    const key = crypto.randomBytes(32).toString('hex');
    const token = crypto.randomBytes(32).toString('hex');
    const now = Date.now();
    db.prepare(`INSERT INTO orders
      (id,keyHash,token,type,amount,duration,createdAt,state,expiresAt)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(id, hash(key), token, type, amount, duration, now,
      admin ? 'paid' : 'new', admin ? now + duration : null);
    return { ...get(id), key };
  }
  function authorize(id, key) {
    const order = typeof id === 'string' && get(id);
    return order && typeof key === 'string' && hash(key) === order.keyHash ? order : null;
  }
  function access(token) {
    if (typeof token !== 'string') return null;
    return db.prepare("SELECT * FROM orders WHERE token=? AND state='paid' AND revokedAt IS NULL AND expiresAt>?")
      .get(token, Date.now());
  }
  function reserve(id, wallet, paymentKey, payload, fromBlock) {
    return db.prepare(`UPDATE orders SET wallet=?,paymentKey=?,payload=?,fromBlock=?,state='pending',error=NULL
      WHERE id=? AND state='new'`).run(wallet, paymentKey, JSON.stringify(payload), String(fromBlock), id).changes;
  }
  const complete = db.transaction((id, txHash) => {
    const order = get(id);
    if (!order || order.state !== 'pending') return order;
    db.prepare("UPDATE orders SET state='paid',txHash=?,expiresAt=?,error=NULL WHERE id=?")
      .run(txHash.toLowerCase(), Date.now() + order.duration, id);
    return get(id);
  });
  return {
    db, get, create, authorize, access, reserve, complete,
    list: () => db.prepare("SELECT id,type,amount,createdAt,expiresAt,revokedAt,state,wallet,txHash,error FROM orders ORDER BY createdAt DESC LIMIT 1000").all(),
    revoke: id => db.prepare("UPDATE orders SET revokedAt=? WHERE id=? AND state='paid'").run(Date.now(), id).changes,
    cancel: id => db.prepare("UPDATE orders SET state='cancelled' WHERE id=? AND state='new'").run(id).changes,
    fail: (id, error) => db.prepare("UPDATE orders SET state='failed',error=? WHERE id=? AND state='pending'").run(error, id).changes,
    pending: (id, txHash, error) => db.prepare('UPDATE orders SET txHash=COALESCE(?,txHash),error=? WHERE id=?')
      .run(txHash || null, error || null, id),
    close: () => db.close()
  };
}

module.exports = { createStore };
