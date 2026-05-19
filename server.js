const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { execFile } = require('child_process');
const https = require('https');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const REGISTRY_FILE = path.join(DATA_DIR, 'registry.json');
const EXCEL_DIR = path.join(DATA_DIR, 'local_storage', 'excel');
const ACCESS_DIR = path.join(DATA_DIR, 'local_storage', 'access');
const NETWORK = process.env.LOGIFLOW_DOCKER_NETWORK || 'logiflow_net';
const DOCKER_SOCKET = process.env.DOCKER_HOST || '/var/run/docker.sock';
const WATCHDOG_MS = Number(process.env.WATCHDOG_INTERVAL_MS || 15000);

const state = {
  databases: {},
  flows: {},
  schemaVersions: [],
  logs: [],
  github: { linked: false, owner: '', repo: '', branch: 'main', lastSync: null, status: 'Not linked' },
  metrics: { docker: false, lastWatchdog: null, containers: {} },
  pulses: []
};
const clients = new Set();

const NODE_TYPES = new Set(['INCOMING_REQUEST', 'RATE_LIMITER', 'AUTH_VERIFY_TOKEN', 'CONDITION', 'TRANSFORM_DATA', 'DB_INSERT', 'DB_FIND', 'AUTH_GENERATE_TOKEN', 'EXT_API_CALL', 'HTTP_RESPONSE']);
const ENGINE_IMAGES = {
  postgres: 'postgres:alpine',
  mysql: 'mysql:8.0',
  mongodb: 'mongo:latest',
  redis: 'redis:alpine'
};

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function safeName(input) {
  return String(input || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 42) || id('db');
}

function now() {
  return new Date().toISOString();
}

function redact(value) {
  if (!value) return '';
  return `${String(value).slice(0, 3)}••••${String(value).slice(-2)}`;
}

function log(level, message, meta = {}) {
  const entry = { id: id('log'), level, message, meta, at: now() };
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, 300);
  console.log(`[${entry.at}] ${level.toUpperCase()} ${message}`, Object.keys(meta).length ? JSON.stringify(meta) : '');
  broadcast('log', entry);
}

async function ensureDataDirs() {
  await fsp.mkdir(EXCEL_DIR, { recursive: true });
  await fsp.mkdir(ACCESS_DIR, { recursive: true });
  await fsp.mkdir(path.join(DATA_DIR, 'exports'), { recursive: true });
}

async function loadState() {
  await ensureDataDirs();
  try {
    const saved = JSON.parse(await fsp.readFile(REGISTRY_FILE, 'utf8'));
    state.databases = saved.databases || {};
    state.flows = saved.flows || {};
    state.schemaVersions = saved.schemaVersions || [];
    state.github = saved.github || state.github;
  } catch (error) {
    await persist();
  }
}

async function persist() {
  await ensureDataDirs();
  const saved = {
    databases: state.databases,
    flows: state.flows,
    schemaVersions: state.schemaVersions,
    github: state.github
  };
  await fsp.writeFile(REGISTRY_FILE, JSON.stringify(saved, null, 2));
}

function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: opts.timeout || 120000, maxBuffer: 1024 * 1024 * 8 }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      }
    });
  });
}

async function docker(args, opts) {
  return run('docker', args, opts);
}

async function hasDocker() {
  try {
    await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 8000 });
    state.metrics.docker = true;
    return true;
  } catch (error) {
    state.metrics.docker = false;
    return false;
  }
}

async function ensureDockerNetwork() {
  if (!(await hasDocker())) throw new Error(`Docker daemon is not reachable through ${DOCKER_SOCKET}`);
  try {
    await docker(['network', 'inspect', NETWORK], { timeout: 8000 });
  } catch (error) {
    await docker(['network', 'create', NETWORK], { timeout: 20000 });
  }
}

function publicDb(db) {
  const clone = { ...db };
  clone.password = redact(db.password);
  return clone;
}

function csvEscape(value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"' && quoted && line[i + 1] === '"') {
      cur += '"';
      i += 1;
    } else if (ch === '"') {
      quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

async function provisionLocalDatabase({ name, username, password, engine }) {
  const dbName = safeName(name);
  const engineKey = engine === 'access' ? 'access' : 'excel';
  const base = engineKey === 'excel' ? path.join(EXCEL_DIR, dbName) : path.join(ACCESS_DIR, dbName);
  await fsp.mkdir(base, { recursive: true });
  if (engineKey === 'excel') {
    const file = path.join(base, 'default.csv');
    if (!fs.existsSync(file)) await fsp.writeFile(file, 'id,created_at,payload\n');
  } else {
    const file = path.join(base, `${dbName}.mdb.json`);
    if (!fs.existsSync(file)) await fsp.writeFile(file, JSON.stringify({ tables: { default: [] }, relations: [], migrations: [] }, null, 2));
  }
  const db = {
    id: id('local'), name: dbName, engine: engineKey, username, password, host: 'local-file', port: null,
    status: 'running', containerName: null, containerId: null, path: base, createdAt: now(), updatedAt: now(), health: 'healthy'
  };
  state.databases[db.id] = db;
  state.schemaVersions.unshift({ id: id('ver'), dbId: db.id, label: `Provisioned ${engineKey} ${dbName}`, at: now(), snapshot: { engine: engineKey, path: base } });
  await persist();
  log('info', `Provisioned local ${engineKey} database`, { db: dbName });
  broadcast('database', publicDb(db));
  return db;
}

async function provisionDockerDatabase({ name, username, password, engine }) {
  await ensureDockerNetwork();
  const dbName = safeName(name);
  const containerName = `logiflow-${engine}-${dbName}-${crypto.randomBytes(3).toString('hex')}`;
  const volumeName = `${containerName}-data`;
  const env = [];
  const args = ['run', '-d', '--restart', 'unless-stopped', '--name', containerName, '--network', NETWORK, '-v', `${volumeName}:/data`];
  if (engine === 'postgres') {
    args.push('-e', `POSTGRES_USER=${username}`, '-e', `POSTGRES_PASSWORD=${password}`, '-e', `POSTGRES_DB=${dbName}`, ENGINE_IMAGES.postgres);
  } else if (engine === 'mysql') {
    args.push('-e', `MYSQL_ROOT_PASSWORD=${password}`, '-e', `MYSQL_DATABASE=${dbName}`, '-e', `MYSQL_USER=${username}`, '-e', `MYSQL_PASSWORD=${password}`, ENGINE_IMAGES.mysql);
  } else if (engine === 'mongodb') {
    args.push('-e', `MONGO_INITDB_ROOT_USERNAME=${username}`, '-e', `MONGO_INITDB_ROOT_PASSWORD=${password}`, ENGINE_IMAGES.mongodb);
  } else if (engine === 'redis') {
    args.push(ENGINE_IMAGES.redis, 'redis-server', '--requirepass', password, '--appendonly', 'yes');
  } else {
    throw new Error(`Unsupported docker engine ${engine}`);
  }
  const { stdout } = await docker(args, { timeout: 180000 });
  const db = {
    id: id('db'), name: dbName, engine, username, password, host: containerName, port: engine === 'postgres' ? 5432 : engine === 'mysql' ? 3306 : engine === 'mongodb' ? 27017 : 6379,
    status: 'starting', containerName, containerId: stdout, volumeName, createdAt: now(), updatedAt: now(), health: 'starting', queryMs: null
  };
  state.databases[db.id] = db;
  state.schemaVersions.unshift({ id: id('ver'), dbId: db.id, label: `Provisioned ${engine} ${dbName}`, at: now(), snapshot: { engine, containerName, volumeName } });
  await persist();
  log('info', `Provisioned Docker ${engine} database`, { db: dbName, containerName });
  broadcast('database', publicDb(db));
  return db;
}

async function healDatabase(db) {
  if (!db.containerName || !ENGINE_IMAGES[db.engine]) return db;
  log('warn', 'Watchdog healing database container', { db: db.name, engine: db.engine });
  try { await docker(['rm', '-f', db.containerName], { timeout: 30000 }); } catch (error) {}
  const oldName = db.containerName;
  const newName = `${oldName}-heal-${crypto.randomBytes(2).toString('hex')}`.slice(0, 62);
  const args = ['run', '-d', '--restart', 'unless-stopped', '--name', newName, '--network', NETWORK, '-v', `${db.volumeName}:/data`];
  if (db.engine === 'postgres') args.push('-e', `POSTGRES_USER=${db.username}`, '-e', `POSTGRES_PASSWORD=${db.password}`, '-e', `POSTGRES_DB=${db.name}`, ENGINE_IMAGES.postgres);
  if (db.engine === 'mysql') args.push('-e', `MYSQL_ROOT_PASSWORD=${db.password}`, '-e', `MYSQL_DATABASE=${db.name}`, '-e', `MYSQL_USER=${db.username}`, '-e', `MYSQL_PASSWORD=${db.password}`, ENGINE_IMAGES.mysql);
  if (db.engine === 'mongodb') args.push('-e', `MONGO_INITDB_ROOT_USERNAME=${db.username}`, '-e', `MONGO_INITDB_ROOT_PASSWORD=${db.password}`, ENGINE_IMAGES.mongodb);
  if (db.engine === 'redis') args.push(ENGINE_IMAGES.redis, 'redis-server', '--requirepass', db.password, '--appendonly', 'yes');
  const { stdout } = await docker(args, { timeout: 180000 });
  db.containerName = newName;
  db.host = newName;
  db.containerId = stdout;
  db.status = 'healed';
  db.health = 'healing';
  db.updatedAt = now();
  await persist();
  broadcast('database', publicDb(db));
  return db;
}

async function watchdog() {
  state.metrics.lastWatchdog = now();
  if (!(await hasDocker())) {
    broadcast('metrics', state.metrics);
    return;
  }
  for (const db of Object.values(state.databases)) {
    if (!db.containerName) continue;
    try {
      const inspect = JSON.parse((await docker(['inspect', db.containerName], { timeout: 10000 })).stdout)[0];
      const running = Boolean(inspect.State.Running);
      const health = inspect.State.Health ? inspect.State.Health.Status : running ? 'running' : 'stopped';
      const statsText = (await docker(['stats', db.containerName, '--no-stream', '--format', '{{json .}}'], { timeout: 15000 })).stdout;
      const stats = statsText ? JSON.parse(statsText) : {};
      db.status = running ? 'running' : 'stopped';
      db.health = health;
      db.memory = stats.MemUsage || 'n/a';
      db.cpu = stats.CPUPerc || 'n/a';
      db.updatedAt = now();
      state.metrics.containers[db.id] = { status: db.status, health: db.health, memory: db.memory, cpu: db.cpu, at: now() };
      if (!running) await healDatabase(db);
    } catch (error) {
      state.metrics.containers[db.id] = { status: 'unreachable', error: error.message, at: now() };
      await healDatabase(db).catch((healError) => log('error', 'Auto-heal failed', { db: db.name, error: healError.message }));
    }
  }
  await persist();
  broadcast('metrics', state.metrics);
}

async function writeLocal(db, table, payload) {
  const row = { id: id('row'), created_at: now(), ...payload };
  if (db.engine === 'excel') {
    const file = path.join(db.path, `${safeName(table || 'default')}.csv`);
    const exists = fs.existsSync(file);
    let headers = Object.keys(row);
    let priorRows = [];
    if (exists) {
      const lines = (await fsp.readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
      headers = parseCsvLine(lines.shift() || '');
      priorRows = lines.map((line) => Object.fromEntries(parseCsvLine(line).map((v, i) => [headers[i], v])));
      for (const key of Object.keys(row)) if (!headers.includes(key)) headers.push(key);
    }
    const allRows = [...priorRows, row];
    const body = `${headers.join(',')}\n${allRows.map((item) => headers.map((key) => csvEscape(item[key])).join(',')).join('\n')}\n`;
    await fsp.writeFile(file, body);
  } else {
    const file = path.join(db.path, `${db.name}.mdb.json`);
    const model = JSON.parse(await fsp.readFile(file, 'utf8'));
    model.tables[table || 'default'] = model.tables[table || 'default'] || [];
    model.tables[table || 'default'].push(row);
    await fsp.writeFile(file, JSON.stringify(model, null, 2));
  }
  return row;
}

async function readLocal(db, table, criteria = {}) {
  if (db.engine === 'excel') {
    const file = path.join(db.path, `${safeName(table || 'default')}.csv`);
    if (!fs.existsSync(file)) return [];
    const lines = (await fsp.readFile(file, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
    const headers = parseCsvLine(lines.shift() || '');
    return lines.map((line) => Object.fromEntries(parseCsvLine(line).map((v, i) => [headers[i], v]))).filter((row) => Object.entries(criteria).every(([k, v]) => !v || String(row[k]) === String(v)));
  }
  const file = path.join(db.path, `${db.name}.mdb.json`);
  const model = JSON.parse(await fsp.readFile(file, 'utf8'));
  const rows = model.tables[table || 'default'] || [];
  return rows.filter((row) => Object.entries(criteria).every(([k, v]) => !v || String(row[k]) === String(v)));
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function dockerQuery(db, op, table, payload = {}, criteria = {}) {
  if (db.status === 'stopped' || db.health === 'unreachable') await healDatabase(db);
  const started = Date.now();
  let result;
  try {
    if (db.engine === 'redis') {
      const key = criteria.key || payload.key || payload.id || 'default';
      if (op === 'insert') {
        const value = JSON.stringify(payload.value !== undefined ? payload.value : payload);
        await docker(['exec', db.containerName, 'redis-cli', '-a', db.password, 'SET', `${table}:${key}`, value], { timeout: 20000 });
        result = { key: `${table}:${key}`, value: payload };
      } else {
        const out = await docker(['exec', db.containerName, 'redis-cli', '-a', db.password, 'GET', `${table}:${key}`], { timeout: 20000 });
        result = out.stdout ? JSON.parse(out.stdout) : null;
      }
    } else if (db.engine === 'postgres') {
      const keys = Object.keys(payload);
      if (op === 'insert') {
        const create = `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, payload JSONB, created_at TIMESTAMPTZ DEFAULT now());`;
        const row = { id: payload.id || id('row'), ...payload };
        const insert = `INSERT INTO ${table} (id, payload) VALUES (${sqlLiteral(row.id)}, ${sqlLiteral(JSON.stringify(row))}::jsonb) ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload RETURNING payload;`;
        result = (await docker(['exec', db.containerName, 'psql', '-U', db.username, '-d', db.name, '-tAc', `${create}${insert}`], { timeout: 30000 })).stdout;
        await mirrorRedis(table, row);
      } else {
        const where = criteria.id ? ` WHERE id=${sqlLiteral(criteria.id)}` : '';
        result = (await docker(['exec', db.containerName, 'psql', '-U', db.username, '-d', db.name, '-tAc', `SELECT COALESCE(json_agg(payload),'[]'::json) FROM ${table}${where};`], { timeout: 30000 })).stdout || '[]';
        result = JSON.parse(result);
      }
    } else if (db.engine === 'mysql') {
      if (op === 'insert') {
        const row = { id: payload.id || id('row'), ...payload };
        const sql = `CREATE TABLE IF NOT EXISTS ${table} (id VARCHAR(128) PRIMARY KEY, payload JSON, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP); INSERT INTO ${table} (id,payload) VALUES (${sqlLiteral(row.id)}, CAST(${sqlLiteral(JSON.stringify(row))} AS JSON)) ON DUPLICATE KEY UPDATE payload=VALUES(payload); SELECT payload FROM ${table} WHERE id=${sqlLiteral(row.id)};`;
        result = (await docker(['exec', db.containerName, 'mysql', '-u', db.username, `-p${db.password}`, db.name, '-NBe', sql], { timeout: 30000 })).stdout;
        await mirrorRedis(table, row);
      } else {
        const where = criteria.id ? ` WHERE id=${sqlLiteral(criteria.id)}` : '';
        const sql = `CREATE TABLE IF NOT EXISTS ${table} (id VARCHAR(128) PRIMARY KEY, payload JSON, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP); SELECT JSON_ARRAYAGG(payload) FROM ${table}${where};`;
        const out = (await docker(['exec', db.containerName, 'mysql', '-u', db.username, `-p${db.password}`, db.name, '-NBe', sql], { timeout: 30000 })).stdout || '[]';
        result = JSON.parse(out);
      }
    } else if (db.engine === 'mongodb') {
      const jsPayload = JSON.stringify(payload);
      const jsCriteria = JSON.stringify(criteria || {});
      const js = op === 'insert'
        ? `db=db.getSiblingDB('${db.name}'); const doc=${jsPayload}; doc._id=doc._id||doc.id||new ObjectId().toString(); db.${table}.updateOne({_id:doc._id},{$set:doc},{upsert:true}); printjson(doc);`
        : `db=db.getSiblingDB('${db.name}'); printjson(db.${table}.find(${jsCriteria}).limit(100).toArray());`;
      const out = await docker(['exec', db.containerName, 'mongosh', '--quiet', '-u', db.username, '-p', db.password, '--authenticationDatabase', 'admin', '--eval', js], { timeout: 30000 });
      result = out.stdout ? JSON.parse(out.stdout) : null;
      if (op === 'insert') await mirrorRedis(table, result);
    }
    db.queryMs = Date.now() - started;
    db.status = 'running';
    return result;
  } catch (error) {
    log('error', 'Database query failed, invoking hot-swap recovery', { db: db.name, engine: db.engine, error: error.message });
    await healDatabase(db).catch(() => null);
    throw error;
  }
}

async function mirrorRedis(table, payload) {
  const redis = Object.values(state.databases).find((db) => db.engine === 'redis' && db.containerName && db.status !== 'stopped');
  if (!redis) return;
  try {
    const key = `${table}:${payload.id || payload._id || id('cache')}`;
    await docker(['exec', redis.containerName, 'redis-cli', '-a', redis.password, 'SET', key, JSON.stringify(payload)], { timeout: 10000 });
  } catch (error) {
    log('warn', 'Redis mirror skipped', { error: error.message });
  }
}

async function queryDatabase(dbId, op, table = 'default', payload = {}, criteria = {}) {
  const db = state.databases[dbId];
  if (!db) throw new Error('Database not found');
  const tableName = safeName(table || 'default').replace(/-/g, '_');
  if (db.engine === 'excel' || db.engine === 'access') return op === 'insert' ? writeLocal(db, tableName, payload) : readLocal(db, tableName, criteria);
  return dockerQuery(db, op, tableName, payload, criteria);
}

function compilePromptToFlow(prompt) {
  const text = String(prompt || '').toLowerCase();
  const nodes = [{ id: 'n0', type: 'INCOMING_REQUEST', x: 70, y: 110, config: {} }];
  const edges = [];
  let idx = 1;
  const add = (type, config = {}) => {
    const node = { id: `n${idx}`, type, x: 70 + idx * 190, y: 110 + (idx % 2) * 95, config };
    nodes.push(node);
    edges.push({ from: `n${idx - 1}`, to: node.id });
    idx += 1;
  };
  if (text.includes('rate')) add('RATE_LIMITER', { maxPerMinute: 60 });
  if (text.includes('token') || text.includes('auth')) add('AUTH_VERIFY_TOKEN', { header: 'authorization' });
  if (text.includes('validate') || text.includes('if ')) add('CONDITION', { field: 'email', operator: 'contains', value: '@' });
  if (text.includes('transform') || text.includes('normalize')) add('TRANSFORM_DATA', { addCreatedAt: true });
  if (text.includes('insert') || text.includes('create') || text.includes('register') || text.includes('save')) add('DB_INSERT', { table: 'users' });
  if (text.includes('find') || text.includes('get') || text.includes('lookup')) add('DB_FIND', { table: 'users' });
  if (text.includes('generate') && text.includes('token')) add('AUTH_GENERATE_TOKEN', { secret: 'logiflow-dev-secret' });
  if (text.includes('http') || text.includes('webhook') || text.includes('external')) add('EXT_API_CALL', { url: 'https://example.com' });
  add('HTTP_RESPONSE', { status: text.includes('created') || text.includes('register') ? 201 : 200 });
  return { id: id('flow'), name: 'Generated API Flow', deployed: false, nodes, edges, route: '/api/simulated/generated/*', bytecode: compileBytecode(nodes, edges), updatedAt: now() };
}

function compileBytecode(nodes, edges) {
  const byFrom = Object.fromEntries(edges.map((edge) => [edge.from, edge.to]));
  const ordered = [];
  let current = nodes.find((n) => n.type === 'INCOMING_REQUEST') || nodes[0];
  const seen = new Set();
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    ordered.push({ op: current.type, id: current.id, config: current.config || {} });
    current = nodes.find((n) => n.id === byFrom[current.id]);
  }
  return { version: 1, createdAt: now(), instructions: ordered };
}

async function executeFlow(flow, req) {
  const runtimeCtx = { req: { body: req.body || {}, query: req.query || {}, params: req.params || {}, headers: req.headers || {}, ip: req.ip }, db_result: {}, vars: {} };
  const nodeMap = new Map(flow.nodes.map((node) => [node.id, node]));
  const nextMap = new Map(flow.edges.map((edge) => [edge.from, edge.to]));
  let current = flow.nodes.find((node) => node.type === 'INCOMING_REQUEST') || flow.nodes[0];
  const visited = new Set();
  let response = null;
  while (current) {
    if (visited.has(current.id)) {
      log('error', 'Emergency loop detection tripped', { flowId: flow.id, nodeId: current.id });
      const err = new Error('Loop Detected');
      err.status = 508;
      throw err;
    }
    visited.add(current.id);
    pulse({ flowId: flow.id, node: current.type });
    const cfg = current.config || {};
    if (current.type === 'RATE_LIMITER') runtimeCtx.vars.rate_limit_checked = true;
    if (current.type === 'AUTH_VERIFY_TOKEN') {
      const auth = runtimeCtx.req.headers[cfg.header || 'authorization'];
      if (cfg.required && !auth) return { status: 401, body: { error: 'Missing authorization token' } };
      runtimeCtx.vars.authenticated = Boolean(auth);
    }
    if (current.type === 'CONDITION') {
      const value = runtimeCtx.req.body[cfg.field] || runtimeCtx.req.query[cfg.field] || runtimeCtx.vars[cfg.field];
      if (cfg.operator === 'contains' && !String(value || '').includes(cfg.value || '')) return { status: 422, body: { error: `Condition failed for ${cfg.field}` } };
      if (cfg.operator === 'equals' && String(value) !== String(cfg.value)) return { status: 422, body: { error: `Condition failed for ${cfg.field}` } };
    }
    if (current.type === 'TRANSFORM_DATA') {
      runtimeCtx.vars.payload = { ...(runtimeCtx.vars.payload || runtimeCtx.req.body) };
      if (cfg.addCreatedAt) runtimeCtx.vars.payload.created_at = now();
      for (const [key, value] of Object.entries(cfg.set || {})) runtimeCtx.vars.payload[key] = value;
    }
    if (current.type === 'DB_INSERT') {
      const databaseId = cfg.databaseId || Object.keys(state.databases)[0];
      runtimeCtx.db_result[current.id] = await queryDatabase(databaseId, 'insert', cfg.table || 'default', runtimeCtx.vars.payload || runtimeCtx.req.body || {}, {});
    }
    if (current.type === 'DB_FIND') {
      const databaseId = cfg.databaseId || Object.keys(state.databases)[0];
      runtimeCtx.db_result[current.id] = await queryDatabase(databaseId, 'find', cfg.table || 'default', {}, cfg.criteria || runtimeCtx.req.query || {});
    }
    if (current.type === 'AUTH_GENERATE_TOKEN') {
      const secret = cfg.secret || process.env.LOGIFLOW_TOKEN_SECRET || 'logiflow-secret';
      runtimeCtx.vars.token = crypto.createHmac('sha256', secret).update(JSON.stringify(runtimeCtx.req.body || {}) + Date.now()).digest('hex');
    }
    if (current.type === 'EXT_API_CALL' && cfg.url) {
      runtimeCtx.vars.external = await httpJson(cfg.url, { method: cfg.method || 'GET' }).catch((error) => ({ error: error.message }));
    }
    if (current.type === 'HTTP_RESPONSE') {
      response = { status: Number(cfg.status || 200), body: { ok: true, flowId: flow.id, db_result: runtimeCtx.db_result, vars: runtimeCtx.vars } };
      break;
    }
    current = nodeMap.get(nextMap.get(current.id));
  }
  return response || { status: 200, body: { ok: true, flowId: flow.id, db_result: runtimeCtx.db_result, vars: runtimeCtx.vars } };
}

function httpJson(url, options = {}, payload) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = payload ? JSON.stringify(payload) : null;
    const req = https.request({ method: options.method || 'GET', hostname: parsed.hostname, path: parsed.pathname + parsed.search, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); } catch (error) { resolve(data); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function githubApi(token, method, apiPath, payload) {
  return new Promise((resolve, reject) => {
    const body = payload ? JSON.stringify(payload) : '';
    const options = {
      hostname: 'api.github.com', method, path: apiPath,
      headers: {
        'User-Agent': 'LogiFlow-GitOps', Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-GitHub-Api-Version': '2022-11-28'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data || '{}'); } catch (error) { parsed = { raw: data }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else reject(new Error(parsed.message || `GitHub API returned ${res.statusCode}`));
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function githubTreeCommit(token, owner, repo, branch, filePath, content, message) {
  const ref = await githubApi(token, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const baseCommitSha = ref.object.sha;
  const baseCommit = await githubApi(token, 'GET', `/repos/${owner}/${repo}/git/commits/${baseCommitSha}`);
  const blob = await githubApi(token, 'POST', `/repos/${owner}/${repo}/git/blobs`, { content, encoding: 'utf-8' });
  const tree = await githubApi(token, 'POST', `/repos/${owner}/${repo}/git/trees`, {
    base_tree: baseCommit.tree.sha,
    tree: [{ path: filePath, mode: '100644', type: 'blob', sha: blob.sha }]
  });
  const commit = await githubApi(token, 'POST', `/repos/${owner}/${repo}/git/commits`, {
    message,
    tree: tree.sha,
    parents: [baseCommitSha]
  });
  await githubApi(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.sha, force: false });
  return { commit, tree, blob };
}

function generateSdk() {
  const routes = Object.values(state.flows).map((flow) => ({ id: flow.id, name: flow.name, url: `/api/simulated/${flow.id}/run`, nodes: flow.nodes.map((n) => n.type) }));
  const databases = Object.values(state.databases).map((db) => ({ id: db.id, name: db.name, engine: db.engine, status: db.status }));
  return `export const logiflowManifest = ${JSON.stringify({ generatedAt: now(), routes, databases }, null, 2)};\n\nexport class LogiFlowClient {\n  constructor(baseUrl, fetchImpl = fetch) { this.baseUrl = String(baseUrl || '').replace(/\\/$/, ''); this.fetch = fetchImpl; }\n  async callFlow(flowId, path = 'run', { method = 'POST', body = {}, query = {}, headers = {} } = {}) {\n    const qs = new URLSearchParams(query).toString();\n    const res = await this.fetch(this.baseUrl + '/api/simulated/' + encodeURIComponent(flowId) + '/' + path + (qs ? '?' + qs : ''), { method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body) });\n    const data = await res.json().catch(() => null);\n    if (!res.ok) throw Object.assign(new Error(data && data.error ? data.error : 'LogiFlow request failed'), { status: res.status, data });\n    return data;\n  }\n}\n\nexport default LogiFlowClient;\n`;
}

function broadcast(type, payload) {
  const data = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

function pulse(payload) {
  const event = { id: id('pulse'), at: now(), ...payload };
  state.pulses.unshift(event);
  state.pulses = state.pulses.slice(0, 80);
  broadcast('pulse', event);
}

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(ROOT, { index: false }));

app.get('/health', (req, res) => res.json({ status: 'OK', port: PORT, uptime: process.uptime(), docker: state.metrics.docker, timestamp: now() }));
app.get('/api/state', (req, res) => res.json({ databases: Object.values(state.databases).map(publicDb), flows: Object.values(state.flows), schemaVersions: state.schemaVersions.slice(0, 50), logs: state.logs.slice(0, 80), github: state.github, metrics: state.metrics, pulses: state.pulses }));
app.get('/api/events', (req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`event: ready\ndata: ${JSON.stringify({ at: now() })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

app.post('/api/provision', async (req, res) => {
  try {
    const { name, username = 'logiflow', password = crypto.randomBytes(12).toString('hex'), engine } = req.body;
    const normalized = String(engine || '').toLowerCase().replace(/\s+/g, '').replace('microsoftaccessfile', 'access').replace('excelspreadsheet', 'excel').replace('mongo', 'mongodb');
    if (!['postgres', 'mysql', 'mongodb', 'redis', 'access', 'excel'].includes(normalized)) return res.status(400).json({ error: 'Unsupported engine' });
    const db = normalized === 'access' || normalized === 'excel' ? await provisionLocalDatabase({ name, username, password, engine: normalized }) : await provisionDockerDatabase({ name, username, password, engine: normalized });
    res.status(201).json({ database: publicDb(db) });
  } catch (error) {
    log('error', 'Provisioning failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/flows/compile', (req, res) => res.json({ flow: compilePromptToFlow(req.body.prompt || '') }));
app.post('/api/flows', async (req, res) => {
  const flow = req.body;
  flow.id = flow.id || id('flow');
  flow.name = flow.name || 'Untitled Flow';
  flow.nodes = Array.isArray(flow.nodes) ? flow.nodes.filter((n) => NODE_TYPES.has(n.type)) : [];
  flow.edges = Array.isArray(flow.edges) ? flow.edges : [];
  flow.bytecode = compileBytecode(flow.nodes, flow.edges);
  flow.deployed = Boolean(req.body.deployed);
  flow.updatedAt = now();
  state.flows[flow.id] = flow;
  await persist();
  log('info', 'Flow saved and compiled', { flowId: flow.id, nodes: flow.nodes.length });
  broadcast('flow', flow);
  res.json({ flow });
});
app.post('/api/flows/:id/deploy', async (req, res) => {
  const flow = state.flows[req.params.id];
  if (!flow) return res.status(404).json({ error: 'Flow not found' });
  flow.deployed = true;
  flow.bytecode = compileBytecode(flow.nodes, flow.edges);
  flow.updatedAt = now();
  await persist();
  res.json({ flow, endpoint: `/api/simulated/${flow.id}/run` });
});
app.get('/api/flows/:id/export', (req, res) => {
  const flow = state.flows[req.params.id];
  if (!flow) return res.status(404).json({ error: 'Flow not found' });
  const bundle = { kind: 'logiflow.edge.bundle', runtime: 'json-wasm-ready', exportedAt: now(), flow, databases: Object.values(state.databases).map(publicDb) };
  res.setHeader('Content-Disposition', `attachment; filename="${flow.id}-edge-map.json"`);
  res.json(bundle);
});
app.post('/api/query/:dbId/:op', async (req, res) => {
  try {
    const result = await queryDatabase(req.params.dbId, req.params.op === 'insert' ? 'insert' : 'find', req.body.table || 'default', req.body.payload || {}, req.body.criteria || {});
    res.json({ result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.post('/api/github/push-sdk', async (req, res) => {
  try {
    const { token, owner, repo, branch = 'main' } = req.body;
    if (!token || !owner || !repo) return res.status(400).json({ error: 'token, owner, and repo are required' });
    const result = await githubTreeCommit(token, owner, repo, branch, 'logiflow-client.js', generateSdk(), `chore: sync LogiFlow SDK ${now()}`);
    state.github = { linked: true, owner, repo, branch, lastSync: now(), status: 'SDK integrated', commit: result.commit && result.commit.sha };
    await persist();
    log('info', 'GitHub SDK sync complete', { owner, repo, branch });
    broadcast('github', state.github);
    res.json({ github: state.github, result });
  } catch (error) {
    state.github.status = error.message;
    log('error', 'GitHub SDK sync failed', { error: error.message });
    res.status(500).json({ error: error.message });
  }
});

app.all('/api/simulated/:flowId/*', async (req, res) => {
  const flow = state.flows[req.params.flowId];
  if (!flow || !flow.deployed) return res.status(404).json({ error: 'Deployed flow not found' });
  try {
    const output = await executeFlow(flow, req);
    res.status(output.status).json(output.body);
  } catch (error) {
    const status = error.status || 500;
    res.status(status).json({ error: error.message });
  }
});

app.get('*', (req, res) => res.sendFile(path.join(ROOT, 'index.html')));
app.use((err, req, res, next) => {
  log('error', 'Unhandled request error', { error: err.message });
  res.status(500).json({ error: 'Internal Server Error' });
});

loadState().then(async () => {
  await hasDocker();
  setInterval(() => watchdog().catch((error) => log('error', 'Watchdog cycle failed', { error: error.message })), WATCHDOG_MS).unref();
  const server = app.listen(PORT, HOST, () => log('info', 'LogiFlow server started', { host: HOST, port: PORT }));
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
});
