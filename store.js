// Povezava z MongoDB. Z MONGODB_URI se poveže na pravo bazo (npr. MongoDB Atlas).
// Brez MONGODB_URI (ali z MONGODB_URI=memory) uporabi preprosto bazo v pomnilniku – samo za razvoj in teste.
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');
const crypto = require('crypto');

const COLLECTIONS = ['users', 'providers', 'services', 'customers', 'bookings', 'overrides', 'blocks', 'notifications'];

async function createIndexes(db) {
  await Promise.all([
    db.collection('users').createIndex({ email: 1 }, { unique: true }),
    db.collection('providers').createIndex({ slug: 1 }, { unique: true }),
    db.collection('providers').createIndex({ userId: 1 }),
    db.collection('services').createIndex({ providerId: 1, sort: 1 }),
    db.collection('customers').createIndex({ phone: 1 }),
    db.collection('customers').createIndex({ email: 1 }),
    db.collection('bookings').createIndex({ providerId: 1, date: 1, status: 1 }),
    db.collection('bookings').createIndex({ customerId: 1, start: -1 }),
    db.collection('bookings').createIndex({ token: 1 }, { unique: true }),
    db.collection('bookings').createIndex({ status: 1, reminderSent: 1, start: 1 }),
    db.collection('overrides').createIndex({ providerId: 1, date: 1 }, { unique: true }),
    db.collection('blocks').createIndex({ providerId: 1, start: 1 }),
    db.collection('notifications').createIndex({ createdAt: -1 }),
  ]);
}

async function connectMongo(uri) {
  const client = await MongoClient.connect(uri);
  const db = client.db(process.env.MONGODB_DB || (uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/) || [])[1] || 'terminko');
  await createIndexes(db);
  const bucket = new GridFSBucket(db, { bucketName: 'images' });
  const S = { client, db, kind: 'mongodb' };
  for (const c of COLLECTIONS) S[c] = db.collection(c);
  S.saveImage = (buffer, contentType, filename) => new Promise((resolve, reject) => {
    const up = bucket.openUploadStream(filename || 'slika', { metadata: { contentType } });
    up.on('error', reject).on('finish', () => resolve(up.id));
    up.end(buffer);
  });
  S.getImage = async id => {
    let oid; try { oid = new ObjectId(String(id)); } catch { return null; }
    const f = await db.collection('images.files').findOne({ _id: oid });
    if (!f) return null;
    const chunks = [];
    for await (const c of bucket.openDownloadStream(oid)) chunks.push(c);
    return { buffer: Buffer.concat(chunks), contentType: f.metadata?.contentType || 'image/jpeg' };
  };
  S.deleteImage = async id => { try { await bucket.delete(new ObjectId(String(id))); } catch { } };
  S.drop = async () => { await db.dropDatabase(); await createIndexes(db); };
  S.isEmpty = async () => (await db.collection('users').estimatedDocumentCount()) === 0;
  return S;
}

// ---------- Baza v pomnilniku (podmnožica MongoDB API, ki jo aplikacija uporablja) ----------
const isOid = v => v instanceof ObjectId;
const norm = v => isOid(v) ? 'oid:' + v.toHexString() : v instanceof Date ? v.getTime() : v;
const eq = (a, b) => Array.isArray(a) ? a.some(x => norm(x) === norm(b)) : norm(a) === norm(b);
const get = (doc, path) => path.split('.').reduce((o, k) => o == null ? undefined : o[k], doc);
const cmp = (a, b) => { a = norm(a); b = norm(b); return a < b ? -1 : a > b ? 1 : 0; };
function matches(doc, filter) {
  for (const [k, cond] of Object.entries(filter || {})) {
    if (k === '$or') { if (!cond.some(f => matches(doc, f))) return false; continue; }
    if (k === '$and') { if (!cond.every(f => matches(doc, f))) return false; continue; }
    const v = get(doc, k);
    if (cond && typeof cond === 'object' && !isOid(cond) && !(cond instanceof Date) && !Array.isArray(cond) && Object.keys(cond).some(x => x[0] === '$')) {
      for (const [op, arg] of Object.entries(cond)) {
        if (op === '$gte' && !(v != null && cmp(v, arg) >= 0)) return false;
        if (op === '$gt' && !(v != null && cmp(v, arg) > 0)) return false;
        if (op === '$lte' && !(v != null && cmp(v, arg) <= 0)) return false;
        if (op === '$lt' && !(v != null && cmp(v, arg) < 0)) return false;
        if (op === '$ne' && eq(v, arg)) return false;
        if (op === '$in' && !arg.some(a => eq(v, a))) return false;
        if (op === '$nin' && arg.some(a => eq(v, a))) return false;
        if (op === '$exists' && (v !== undefined) !== !!arg) return false;
      }
    } else if (!eq(v, cond) && !(cond === null && v === undefined)) return false;
  }
  return true;
}
const clone = d => d == null ? d : structuredCloneDoc(d);
function structuredCloneDoc(v) {
  if (isOid(v)) return new ObjectId(v.toHexString());
  if (v instanceof Date) return new Date(v);
  if (Buffer.isBuffer(v)) return Buffer.from(v);
  if (Array.isArray(v)) return v.map(structuredCloneDoc);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, structuredCloneDoc(x)]));
  return v;
}
function setPath(doc, path, val) { const ks = path.split('.'); let o = doc; ks.slice(0, -1).forEach(k => { o[k] ??= {}; o = o[k]; }); o[ks[ks.length - 1]] = val; }
function applyUpdate(doc, upd, inserting) {
  for (const [op, fields] of Object.entries(upd)) {
    for (const [k, v] of Object.entries(fields)) {
      if (op === '$set') setPath(doc, k, clone(v));
      else if (op === '$setOnInsert') { if (inserting) setPath(doc, k, clone(v)); }
      else if (op === '$inc') setPath(doc, k, (get(doc, k) || 0) + v);
      else if (op === '$unset') { const ks = k.split('.'); let o = doc; ks.slice(0, -1).forEach(x => { o = o?.[x]; }); if (o) delete o[ks[ks.length - 1]]; }
      else if (op === '$push') { const a = get(doc, k) || []; a.push(clone(v)); setPath(doc, k, a); }
      else throw new Error('nepodprt operator ' + op);
    }
  }
}
class Cursor {
  constructor(docs) { this.docs = docs; }
  sort(spec) { const e = Object.entries(spec); this.docs.sort((a, b) => { for (const [k, d] of e) { const c = cmp(get(a, k), get(b, k)); if (c) return c * d; } return 0; }); return this; }
  limit(n) { if (n) this.docs = this.docs.slice(0, n); return this; }
  project() { return this; }
  async toArray() { return this.docs.map(clone); }
}
class MemCollection {
  constructor(name, unique = []) { this.name = name; this.docs = []; this.unique = unique; }
  checkUnique(doc, self) {
    for (const keys of this.unique) if (this.docs.some(d => d !== self && keys.every(k => eq(get(d, k), get(doc, k))))) {
      const e = new Error(`E11000 duplicate key ${this.name} ${keys}`); e.code = 11000; throw e;
    }
  }
  async insertOne(doc) { doc._id ??= new ObjectId(); const c = clone(doc); this.checkUnique(c); this.docs.push(c); return { insertedId: doc._id }; }
  async insertMany(docs) { for (const d of docs) await this.insertOne(d); return { insertedCount: docs.length }; }
  async findOne(filter, opts = {}) { const c = this.find(filter); if (opts.sort) c.sort(opts.sort); return clone(c.docs[0] || null); }
  find(filter, opts = {}) { const c = new Cursor(this.docs.filter(d => matches(d, filter))); if (opts.sort) c.sort(opts.sort); if (opts.limit) c.limit(opts.limit); return c; }
  async countDocuments(filter) { return this.docs.filter(d => matches(d, filter)).length; }
  async estimatedDocumentCount() { return this.docs.length; }
  async updateOne(filter, upd, opts = {}) {
    const d = this.docs.find(x => matches(x, filter));
    if (d) { const before = clone(d); applyUpdate(d, upd); try { this.checkUnique(d, d); } catch (e) { Object.assign(d, before); throw e; } return { matchedCount: 1, modifiedCount: 1 }; }
    if (opts.upsert) {
      const n = { _id: new ObjectId() };
      for (const [k, v] of Object.entries(filter)) if (!k.startsWith('$') && (typeof v !== 'object' || isOid(v) || v instanceof Date)) setPath(n, k, v);
      applyUpdate(n, upd, true); this.checkUnique(n); this.docs.push(n); return { matchedCount: 0, upsertedId: n._id };
    }
    return { matchedCount: 0, modifiedCount: 0 };
  }
  async findOneAndUpdate(filter, upd, opts = {}) { const r = await this.updateOne(filter, upd, opts); const id = r.upsertedId; return id ? this.findOne({ _id: id }) : this.findOne(filter); }
  async updateMany(filter, upd) { const ds = this.docs.filter(x => matches(x, filter)); ds.forEach(d => applyUpdate(d, upd)); return { matchedCount: ds.length, modifiedCount: ds.length }; }
  async deleteOne(filter) { const i = this.docs.findIndex(x => matches(x, filter)); if (i >= 0) this.docs.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; }
  async deleteMany(filter) { const n = this.docs.length; this.docs = this.docs.filter(x => !matches(x, filter)); return { deletedCount: n - this.docs.length }; }
  async createIndex() { }
}
function memoryStore() {
  const uniq = { users: [['email']], providers: [['slug']], bookings: [['token']], overrides: [['providerId', 'date']] };
  const S = { kind: 'memory' };
  const reset = () => { for (const c of COLLECTIONS) S[c] = new MemCollection(c, uniq[c]); S.images = new Map(); };
  reset();
  S.saveImage = async (buffer, contentType) => { const id = new ObjectId(); S.images.set(id.toHexString(), { buffer, contentType }); return id; };
  S.getImage = async id => S.images.get(String(id)) || null;
  S.deleteImage = async id => { S.images.delete(String(id)); };
  S.drop = async () => reset();
  S.isEmpty = async () => S.users.docs.length === 0;
  return S;
}

let store;
async function connect() {
  if (store) return store;
  const uri = process.env.MONGODB_URI;
  store = !uri || uri === 'memory' ? memoryStore() : await connectMongo(uri);
  if (store.kind === 'memory') console.warn('OPOZORILO: MONGODB_URI ni nastavljen – podatki so samo v pomnilniku in se ob ponovnem zagonu izgubijo.');
  return store;
}
const S = () => { if (!store) throw new Error('Baza še ni povezana (pokliči connect())'); return store; };

const oid = v => { try { return v instanceof ObjectId ? v : new ObjectId(String(v)); } catch { return null; } };
const sid = v => v == null ? null : String(v);

function hash(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function verify(pw, stored) {
  const [salt, h] = String(stored).split(':');
  if (!salt || !h) return false;
  const a = crypto.scryptSync(pw, salt, 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Privzete vrednosti nove naročnice
const providerDefaults = () => ({
  description: '', address: '', phone: '', email: '', coverImageId: null, accentColor: '#9a7452', weeklyHours: [],
  theme: 'default', tagline: '', notice: '', instagram: '', galleryImageIds: [],
  settings: { slotStep: 15, bufferMin: 0, minNoticeHours: 2, maxDaysAhead: 60, cancelHours: 24 },
  active: true, createdAt: new Date(),
});

module.exports = { connect, S, oid, sid, ObjectId, hash, verify, matches, providerDefaults };
