import config from './config';
import fs from 'fs';
import express from 'express';
import bodyParser from 'body-parser';
import compression from 'compression';
import os from 'os';
import cors from 'cors';
import Redis from 'ioredis';
import https from 'https';
import http from 'http';
import { Server } from 'socket.io';
import { searchYoutube } from './utils/youtube';
import { Room } from './room';
import {
  getRedisCountDay,
  getRedisCountDayDistinct,
  redisCount,
} from './utils/redis';
import { getCustomerByEmail, createSelfServicePortal } from './utils/stripe';
import { deleteUser, validateUserToken } from './utils/firebase';
import path from 'path';
import { Client } from 'pg';
import { getStartOfDay } from './utils/time';
import { getBgVMManagers, getSessionLimitSeconds } from './vm/utils';
import { hashString } from './utils/string';
import { insertObject, upsertObject } from './utils/postgres';
import axios from 'axios';
import crypto from 'crypto';
import zlib from 'zlib';
import util from 'util';
import ecosystem from './ecosystem.config';
import { statsAgg } from './utils/statsAgg';
import { resolveShard } from './utils/resolveShard';
import { makeRoomName, makeUserName } from './utils/moniker';

const gzip = util.promisify(zlib.gzip);

const releaseInterval = 5 * 60 * 1000;
const releaseBatches = 10;
const app = express();
let server: any = null;
if (config.HTTPS) {
  const key = fs.readFileSync(config.SSL_KEY_FILE as string);
  const cert = fs.readFileSync(config.SSL_CRT_FILE as string);
  server = https.createServer({ key: key, cert: cert }, app);
} else {
  server = new http.Server(app);
}
const io = new Server(server, { cors: {}, transports: ['websocket'] });
let redis: Redis | undefined = undefined;
if (config.REDIS_URL) {
  redis = new Redis(config.REDIS_URL);
}
let postgres: Client | undefined = undefined;
if (config.DATABASE_URL) {
  postgres = new Client({
    connectionString: config.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  postgres.connect();
}

const launchTime = Number(new Date());
const rooms = new Map<string, Room>();
init();

async function init() {
  if (postgres) {
    console.time('[LOADROOMSPOSTGRES]');
    const persistedRooms = await getAllRooms();
    console.log('found %s rooms in postgres', persistedRooms.length);
    for (let i = 0; i < persistedRooms.length; i++) {
      const key = persistedRooms[i].roomId;
      const data = persistedRooms[i].data
        ? JSON.stringify(persistedRooms[i].data)
        : undefined;
      const room = new Room(io, key, data);
      rooms.set(key, room);
    }
    console.timeEnd('[LOADROOMSPOSTGRES]');
  }

  if (!rooms.has('/default')) {
    rooms.set('/default', new Room(io, '/default'));
  }

  server.listen(config.PORT, config.HOST);
  // Following functions iterate over in-memory rooms
  setInterval(minuteMetrics, 60 * 1000);
  setInterval(release, releaseInterval / releaseBatches);
  setInterval(freeUnusedRooms, 5 * 60 * 1000);
  saveRooms();
  if (process.env.NODE_ENV === 'development') {
    try {
      require('./vmWorker');
      // require('./syncSubs');
      // require('./timeSeries');
    } catch (e) {
      console.error(e);
    }
  }
}

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.raw({ type: 'text/plain', limit: 1000000 }));

app.get('/ping', (_req, res) => {
  res.json('pong');
});

// Data's already compressed so go before the compression middleware
app.get('/subtitle/:hash', async (req, res) => {
  const gzipped = await redis?.getBuffer('subtitle:' + req.params.hash);
  if (!gzipped) {
    return res.status(404).end('not found');
  }
  res.setHeader('Content-Encoding', 'gzip');
  res.end(gzipped);
});

app.use(compression());

app.post('/subtitle', async (req, res) => {
  const data = req.body;
  if (!redis) {
    return;
  }
  // calculate hash, gzip and save to redis
  const hash = crypto
    .createHash('sha256')
    .update(data, 'utf8')
    .digest()
    .toString('hex');
  let gzipData = (await gzip(data)) as Buffer;
  await redis.setex('subtitle:' + hash, 24 * 60 * 60, gzipData);
  redisCount('subUploads');
  return res.json({ hash });
});

app.get('/downloadSubtitles', async (req, res) => {
  const response = await axios.get(req.query.url as string, {
    responseType: 'arraybuffer',
  });
  res.append('Content-Encoding', 'gzip');
  res.append('Content-Type', 'text/plain');
  redisCount('subDownloadsOS');
  res.end(response.data);
});

app.get('/searchSubtitles', async (req, res) => {
  try {
    const title = req.query.title as string;
    const url = req.query.url as string;
    let subUrl = '';
    if (url) {
      const startResp = await axios({
        method: 'get',
        url: url,
        headers: {
          Range: 'bytes=0-65535',
        },
        responseType: 'arraybuffer',
      });
      const start = startResp.data;
      const size = Number(startResp.headers['content-range'].split('/')[1]);
      const endResp = await axios({
        method: 'get',
        url: url,
        headers: {
          Range: `bytes=${size - 65536}-`,
        },
        responseType: 'arraybuffer',
      });
      const end = endResp.data;
      // console.log(start, end, size);
      let hash = computeOpenSubtitlesHash(start, end, size);
      // hash = 'f65334e75574f00f';
      // Search API for subtitles by hash
      subUrl = `https://rest.opensubtitles.org/search/moviebytesize-${size}/moviehash-${hash}/sublanguageid-eng`;
    } else if (title) {
      subUrl = `https://rest.opensubtitles.org/search/query-${encodeURIComponent(
        title
      )}/sublanguageid-eng`;
    }
    console.log(subUrl);
    const response = await axios.get(subUrl, {
      headers: { 'User-Agent': 'VLSub 0.10.2' },
    });
    // console.log(response);
    const subtitles = response.data;
    res.json(subtitles);
  } catch (e: any) {
    console.error(e.message);
    res.json([]);
  }
  redisCount('subSearchesOS');
});

app.get('/stats', async (req, res) => {
  if (req.query.key && req.query.key === config.STATS_KEY) {
    const stats = await getStats();
    res.json(stats);
  } else {
    return res.status(403).json({ error: 'Access Denied' });
  }
});

app.get('/statsAgg', async (req, res) => {
  if (req.query.key && req.query.key === config.STATS_KEY) {
    const stats = await statsAgg();
    res.json(stats);
  } else {
    return res.status(403).json({ error: 'Access Denied' });
  }
});

app.get('/health/:metric', async (req, res) => {
  const vmManagerStats = (
    await axios.get('http://localhost:' + config.VMWORKER_PORT + '/stats')
  ).data;
  const result = vmManagerStats[req.params.metric]?.availableVBrowsers?.length;
  res.status(result ? 200 : 500).json(result);
});

app.get('/timeSeries', async (req, res) => {
  if (req.query.key && req.query.key === config.STATS_KEY && redis) {
    const timeSeriesData = await redis.lrange('timeSeries', 0, -1);
    const timeSeries = timeSeriesData.map((entry) => JSON.parse(entry));
    res.json(timeSeries);
  } else {
    return res.status(403).json({ error: 'Access Denied' });
  }
});

app.get('/youtube', async (req, res) => {
  if (typeof req.query.q === 'string') {
    try {
      await redisCount('youtubeSearch');
      const items = await searchYoutube(req.query.q);
      res.json(items);
    } catch {
      return res.status(500).json({ error: 'youtube error' });
    }
  } else {
    return res.status(500).json({ error: 'query must be a string' });
  }
});

app.post('/createRoom', async (req, res) => {
  const genName = () => '/' + makeRoomName(config.SHARD);
  let name = genName();
  console.log('createRoom: ', name);
  const newRoom = new Room(io, name);
  if (postgres) {
    const now = new Date();
    const roomObj = {
      roomId: newRoom.roomId,
      lastUpdateTime: now,
      creationTime: now,
    };
    try {
      await insertObject(postgres, 'room', roomObj);
    } catch (e) {
      redisCount('createRoomError');
    }
  }
  const decoded = await validateUserToken(req.body?.uid, req.body?.token);
  newRoom.creator = decoded?.email;
  const preload = (req.body?.video || '').slice(0, 20000);
  if (preload) {
    redisCount('createRoomPreload');
    newRoom.video = preload;
    newRoom.paused = true;
    await newRoom.saveRoom();
  }
  rooms.set(name, newRoom);
  res.json({ name });
});

app.post('/manageSub', async (req, res) => {
  const decoded = await validateUserToken(req.body?.uid, req.body?.token);
  if (!decoded) {
    return res.status(400).json({ error: 'invalid user token' });
  }
  if (!decoded.email) {
    return res.status(400).json({ error: 'no email found' });
  }
  const customer = await getCustomerByEmail(decoded.email);
  if (!customer) {
    return res.status(400).json({ error: 'customer not found' });
  }
  const session = await createSelfServicePortal(
    customer.id,
    req.body?.return_url
  );
  return res.json(session);
});

app.delete('/deleteAccount', async (req, res) => {
  // TODO pass this in req.query instead
  const decoded = await validateUserToken(req.body?.uid, req.body?.token);
  if (!decoded) {
    return res.status(400).json({ error: 'invalid user token' });
  }
  if (postgres) {
    // Delete rooms
    await postgres?.query('DELETE FROM room WHERE owner = $1', [decoded.uid]);
    // Delete linked accounts
    await postgres?.query('DELETE FROM link_account WHERE uid = $1', [
      decoded.uid,
    ]);
  }
  await deleteUser(decoded.uid);
  redisCount('deleteAccount');
  return res.json({});
});

app.get('/metadata', async (req, res) => {
  const decoded = await validateUserToken(
    req.query?.uid as string,
    req.query?.token as string
  );
  let isCustomer = false;
  let isSubscriber = false;
  if (decoded?.email) {
    const customer = await getCustomerByEmail(decoded.email);
    // Is the user an active subscriber?
    isSubscriber = Boolean(
      customer?.subscriptions?.data?.find((sub) => sub?.status === 'active')
    );
    // Has the user ever been a subscriber?
    isCustomer = Boolean(customer);
  }
  let isFreePoolFull = false;
  try {
    isFreePoolFull = (
      await axios.get(
        'http://localhost:' + config.VMWORKER_PORT + '/isFreePoolFull'
      )
    ).data.isFull;
  } catch (e) {
    console.warn(e);
  }
  const beta =
    decoded?.email != null &&
    Boolean(config.BETA_USER_EMAILS.split(',').includes(decoded?.email));
  const streamPath = beta ? config.STREAM_PATH : undefined;
  // log metrics but don't wait for it
  if (postgres && decoded?.uid) {
    upsertObject(
      postgres,
      'active_user',
      { uid: decoded?.uid, lastActiveTime: new Date() },
      { uid: true }
    );
  }
  return res.json({
    isSubscriber,
    isCustomer,
    isFreePoolFull,
    beta,
    streamPath,
  });
});

app.get('/resolveRoom/:vanity', async (req, res) => {
  const vanity = req.params.vanity;
  const result = await postgres?.query(
    `SELECT "roomId", vanity from room WHERE LOWER(vanity) = $1`,
    [vanity?.toLowerCase() ?? '']
  );
  // console.log(vanity, result.rows);
  // We also use this for checking name availability, so just return empty response if it doesn't exist (http 200)
  return res.json(result?.rows[0]);
});

app.get('/resolveShard/:roomId', async (req, res) => {
  const shardNum = resolveShard(req.params.roomId);
  return res.send(String(config.SHARD ? shardNum : ''));
});

app.get('/listRooms', async (req, res) => {
  const decoded = await validateUserToken(
    req.query?.uid as string,
    req.query?.token as string
  );
  if (!decoded) {
    return res.status(400).json({ error: 'invalid user token' });
  }
  const result = await postgres?.query<PersistentRoom>(
    `SELECT "roomId", vanity from room WHERE owner = $1`,
    [decoded.uid]
  );
  return res.json(result?.rows ?? []);
});

app.delete('/deleteRoom', async (req, res) => {
  const decoded = await validateUserToken(
    req.query?.uid as string,
    req.query?.token as string
  );
  if (!decoded) {
    return res.status(400).json({ error: 'invalid user token' });
  }
  const result = await postgres?.query(
    `DELETE from room WHERE owner = $1 and "roomId" = $2`,
    [decoded.uid, req.query.roomId]
  );
  return res.json(result?.rows);
});

app.get('/linkAccount', async (req, res) => {
  const decoded = await validateUserToken(
    req.query?.uid as string,
    req.query?.token as string
  );
  if (!decoded) {
    return res.status(400).json({ error: 'invalid user token' });
  }
  if (!postgres) {
    return res.status(400).json({ error: 'invalid database client' });
  }
  // Get the linked accounts for the user
  let linkAccounts: LinkAccount[] = [];
  if (decoded?.uid) {
    const result = await postgres?.query(
      'SELECT kind, accountid, accountname, discriminator FROM link_account WHERE uid = $1',
      [decoded?.uid]
    );
    linkAccounts = result.rows;
  }
  return res.json(linkAccounts);
});

app.post('/linkAccount', async (req, res) => {
  const decoded = await validateUserToken(
    req.body?.uid as string,
    req.body?.token as string
  );
  if (!decoded) {
    return res.status(400).json({ error: 'invalid user token' });
  }
  if (!postgres) {
    return res.status(400).json({ error: 'invalid database client' });
  }
  const kind = req.body?.kind;
  if (kind === 'discord') {
    const tokenType = req.body?.tokenType;
    const accessToken = req.body.accessToken;
    // Get the token and verify the user
    const response = await axios.get('https://discord.com/api/users/@me', {
      headers: {
        authorization: `${tokenType} ${accessToken}`,
      },
    });
    const accountid = response.data.id;
    const accountname = response.data.username;
    const discriminator = response.data.discriminator;
    // Store the user id, username, discriminator
    await upsertObject(
      postgres,
      'link_account',
      {
        accountid: accountid,
        accountname: accountname,
        discriminator: discriminator,
        uid: decoded.uid,
        kind: kind,
      },
      { uid: true, kind: true }
    );
    return res.json({});
  }
});

app.delete('/linkAccount', async (req, res) => {
  // TODO read from req.query instead
  const decoded = await validateUserToken(
    req.body?.uid as string,
    req.body?.token as string
  );
  if (!decoded) {
    return res.status(400).json({ error: 'invalid user token' });
  }
  if (!postgres) {
    return res.status(400).json({ error: 'invalid database client' });
  }
  await postgres.query(
    'DELETE FROM link_account WHERE uid = $1 AND kind = $2',
    [decoded.uid, req.body.kind]
  );
  res.json({});
});

app.get('/generateName', async (req, res) => {
  return res.send(makeUserName());
});

app.use(express.static(config.BUILD_DIRECTORY));
// Send index.html for all other requests (SPA)
app.use('/*', (_req, res) => {
  res.sendFile(
    path.resolve(__dirname + `/../${config.BUILD_DIRECTORY}/index.html`)
  );
});

async function saveRooms() {
  while (true) {
    // console.time('[SAVEROOMS]');
    const roomArr = Array.from(rooms.values());
    for (let i = 0; i < roomArr.length; i++) {
      if (roomArr[i].roster.length) {
        await roomArr[i].saveRoom();
      }
    }
    // console.timeEnd('[SAVEROOMS]');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

let currBatch = 0;
async function release() {
  // Reset VMs in rooms that are:
  // older than the session limit
  // assigned to a room with no users
  const roomArr = Array.from(rooms.values()).filter((room) => {
    return hashString(room.roomId) % releaseBatches === currBatch;
  });
  console.log('[RELEASE][%s] %s rooms in batch', currBatch, roomArr.length);
  for (let i = 0; i < roomArr.length; i++) {
    const room = roomArr[i];
    if (room.vBrowser && room.vBrowser.assignTime) {
      const maxTime = getSessionLimitSeconds(room.vBrowser.large) * 1000;
      const elapsed = Number(new Date()) - room.vBrowser.assignTime;
      const ttl = maxTime - elapsed;
      const isTimedOut = ttl && ttl < releaseInterval;
      const isAlmostTimedOut = ttl && ttl < releaseInterval * 2;
      const isRoomEmpty = room.roster.length === 0;
      const isRoomIdle =
        Date.now() - Number(room.lastUpdateTime) > 5 * 60 * 1000;
      if (isTimedOut || (isRoomEmpty && isRoomIdle)) {
        console.log('[RELEASE][%s] VM in room:', currBatch, room.roomId);
        room.stopVBrowserInternal();
        if (isTimedOut) {
          room.addChatMessage(null, {
            id: '',
            system: true,
            cmd: 'vBrowserTimeout',
            msg: '',
          });
          redisCount('vBrowserTerminateTimeout');
        } else if (isRoomEmpty) {
          redisCount('vBrowserTerminateEmpty');
        }
      } else if (isAlmostTimedOut) {
        room.addChatMessage(null, {
          id: '',
          system: true,
          cmd: 'vBrowserAlmostTimeout',
          msg: '',
        });
      }
    }
  }
  currBatch = (currBatch + 1) % releaseBatches;
}

async function minuteMetrics() {
  const roomArr = Array.from(rooms.values());
  for (let i = 0; i < roomArr.length; i++) {
    const room = roomArr[i];
    if (room.vBrowser && room.vBrowser.id) {
      // Renew the locks
      await redis?.expire(
        'lock:' + room.vBrowser.provider + ':' + room.vBrowser.id,
        300
      );
      await redis?.expire('vBrowserUIDLock:' + room.vBrowser?.creatorUID, 120);

      const expireTime = getStartOfDay() / 1000 + 86400;
      if (room.vBrowser?.creatorClientID) {
        await redis?.zincrby(
          'vBrowserClientIDMinutes',
          1,
          room.vBrowser.creatorClientID
        );
        await redis?.expireat('vBrowserClientIDMinutes', expireTime);
      }
      if (room.vBrowser?.creatorUID) {
        await redis?.zincrby(
          'vBrowserUIDMinutes',
          1,
          room.vBrowser?.creatorUID
        );
        await redis?.expireat('vBrowserUIDMinutes', expireTime);
      }
    }
  }
}

async function freeUnusedRooms() {
  // Clean up rooms that are no longer persisted and empty
  // Frees up some JS memory space when process is long-running
  const persistedRooms = await getAllRooms();
  const persistedSet = new Set(persistedRooms.map((room) => room.roomId));
  rooms.forEach(async (room, key) => {
    if (room.roster.length === 0) {
      if (!persistedSet.has(room.roomId)) {
        room.destroy();
        rooms.delete(key);
      }
    }
  });
}

async function getAllRooms() {
  if (!postgres) {
    return [];
  }
  let range = '/%';
  if (config.SHARD) {
    const numShards = ecosystem.apps.filter((app) => app.env?.SHARD).length;
    const selection = [];
    for (let i = 97; i < 123; i++) {
      const letterShard = (i % numShards) + 1;
      if (letterShard === Number(config.SHARD)) {
        selection.push(String.fromCharCode(i));
      }
    }
    range = `/(${selection.join('|')})%`;
  }
  console.log(config.SHARD);
  console.log(range);
  return (
    await postgres.query<PersistentRoom>(
      `SELECT * from room where "roomId" SIMILAR TO '${range}'`
    )
  ).rows;
}

async function getStats() {
  // Per-shard data is prefixed with "current"
  const now = Number(new Date());
  let currentUsers = 0;
  let currentHttp = 0;
  let currentVBrowser = 0;
  let currentVBrowserLarge = 0;
  let currentScreenShare = 0;
  let currentFileShare = 0;
  let currentVideoChat = 0;
  let currentRoomSizeCounts: NumberDict = {};
  let currentVBrowserUIDCounts: NumberDict = {};
  let currentRoomCount = rooms.size;
  rooms.forEach((room) => {
    const obj = {
      video: room.video,
      rosterLength: room.roster.length,
      videoChats: room.roster.filter((p) => p.isVideoChat).length,
      vBrowser: room.vBrowser,
    };
    currentUsers += obj.rosterLength;
    currentVideoChat += obj.videoChats;
    if (obj.vBrowser) {
      currentVBrowser += 1;
    }
    if (obj.vBrowser && obj.vBrowser.large) {
      currentVBrowserLarge += 1;
    }
    if (obj.video?.startsWith('http') && obj.rosterLength) {
      currentHttp += 1;
    }
    if (obj.video?.startsWith('screenshare://') && obj.rosterLength) {
      currentScreenShare += 1;
    }
    if (obj.video?.startsWith('fileshare://') && obj.rosterLength) {
      currentFileShare += 1;
    }
    if (obj.rosterLength > 0) {
      if (!currentRoomSizeCounts[obj.rosterLength]) {
        currentRoomSizeCounts[obj.rosterLength] = 0;
      }
      currentRoomSizeCounts[obj.rosterLength] += 1;
    }
    if (obj.vBrowser && obj.vBrowser.creatorUID) {
      if (!currentVBrowserUIDCounts[obj.vBrowser.creatorUID]) {
        currentVBrowserUIDCounts[obj.vBrowser.creatorUID] = 0;
      }
      currentVBrowserUIDCounts[obj.vBrowser.creatorUID] += 1;
    }
  });

  currentVBrowserUIDCounts = Object.fromEntries(
    Object.entries(currentVBrowserUIDCounts).filter(([, val]) => val > 1)
  );

  const dbRoomData = (
    await postgres?.query(
      `SELECT "roomId", "creationTime", "lastUpdateTime", vanity, "isSubRoom", "roomTitle", "roomDescription", "mediaPath", owner, password from room WHERE "lastUpdateTime" > NOW() - INTERVAL '7 day' ORDER BY "creationTime" DESC`
    )
  )?.rows;
  const currentRoomData = dbRoomData
    ?.map((dbRoom) => {
      const room = rooms.get(dbRoom.roomId);
      if (!room) {
        return null;
      }
      const obj = {
        roomId: room.roomId,
        video: room.video || undefined,
        videoTS: room.videoTS || undefined,
        creationTime: dbRoom.creationTime || undefined,
        lastUpdateTime: dbRoom.lastUpdateTime || undefined,
        vanity: dbRoom.vanity || undefined,
        isSubRoom: dbRoom.isSubRoom || undefined,
        owner: dbRoom.owner || undefined,
        password: dbRoom.password || undefined,
        roomTitle: dbRoom.roomTitle || undefined,
        roomDescription: dbRoom.roomDescription || undefined,
        mediaPath: dbRoom.mediaPath || undefined,
        rosterLength: room.roster.length,
        roster: room.getRosterForStats(),
        vBrowser: room.vBrowser,
        vBrowserElapsed:
          room.vBrowser?.assignTime && now - room.vBrowser?.assignTime,
        lock: room.lock || undefined,
        creator: room.creator || undefined,
      };
      if (obj.video || obj.rosterLength > 0) {
        return obj;
      } else {
        return null;
      }
    })
    .filter(Boolean);

  // Per-shard data that we want to see in an array
  const currentUptime = [Number(new Date()) - launchTime];
  const currentMemUsage = [process.memoryUsage().rss];

  // Singleton stats below (same for all shards so don't combine)
  let vBrowserWaiting = Number(await redis?.get('currentVBrowserWaiting'));
  const cpuUsage = os.loadavg();
  const redisUsage = Number(
    (await redis?.info())
      ?.split('\n')
      .find((line) => line.startsWith('used_memory:'))
      ?.split(':')[1]
      .trim()
  );
  const postgresUsage = Number(
    (await postgres?.query(`SELECT pg_database_size('postgres');`))?.rows[0]
      .pg_database_size
  );
  const numPermaRooms = Number(
    (await postgres?.query('SELECT count(1) from room WHERE owner IS NOT NULL'))
      ?.rows[0].count
  );
  const numSubs = Number(
    (await postgres?.query('SELECT count(1) from subscriber'))?.rows[0].count
  );
  const discordBotWatch = await getRedisCountDay('discordBotWatch');
  const createRoomErrors = await getRedisCountDay('createRoomError');
  const deleteAccounts = await getRedisCountDay('deleteAccount');
  const chatMessages = await getRedisCountDay('chatMessages');
  const addReactions = await getRedisCountDay('addReaction');
  const hetznerApiRemaining = Number(await redis?.get('hetznerApiRemaining'));
  const vBrowserStarts = await getRedisCountDay('vBrowserStarts');
  const vBrowserLaunches = await getRedisCountDay('vBrowserLaunches');
  const vBrowserFails = await getRedisCountDay('vBrowserFails');
  const vBrowserStagingFails = await getRedisCountDay('vBrowserStagingFails');
  const vBrowserStopTimeout = await getRedisCountDay(
    'vBrowserTerminateTimeout'
  );
  const vBrowserStopEmpty = await getRedisCountDay('vBrowserTerminateEmpty');
  const vBrowserStopManual = await getRedisCountDay('vBrowserTerminateManual');
  const recaptchaRejectsLowScore = await getRedisCountDay(
    'recaptchaRejectsLowScore'
  );
  const vBrowserStartMS = await redis?.lrange('vBrowserStartMS', 0, -1);
  const vBrowserStageRetries = await redis?.lrange(
    'vBrowserStageRetries',
    0,
    -1
  );
  const vBrowserStageFails = await redis?.lrange('vBrowserStageFails', 0, -1);
  const vBrowserSessionMS = await redis?.lrange('vBrowserSessionMS', 0, -1);
  // const vBrowserVMLifetime = await redis?.lrange('vBrowserVMLifetime', 0, -1);
  const recaptchaRejectsOther = await getRedisCountDay('recaptchaRejectsOther');
  const urlStarts = await getRedisCountDay('urlStarts');
  const playlistAdds = await getRedisCountDay('playlistAdds');
  const screenShareStarts = await getRedisCountDay('screenShareStarts');
  const fileShareStarts = await getRedisCountDay('fileShareStarts');
  const mediasoupStarts = await getRedisCountDay('mediasoupStarts');
  const videoChatStarts = await getRedisCountDay('videoChatStarts');
  const connectStarts = await getRedisCountDay('connectStarts');
  const connectStartsDistinct = await getRedisCountDayDistinct(
    'connectStartsDistinct'
  );
  const subUploads = await getRedisCountDay('subUploads');
  const subDownloadsOS = await getRedisCountDay('subDownloadsOS');
  const subSearchesOS = await getRedisCountDay('subSearchesOS');
  const youtubeSearch = await getRedisCountDay('youtubeSearch');
  const vBrowserClientIDs = await redis?.zrevrangebyscore(
    'vBrowserClientIDs',
    '+inf',
    '0',
    'WITHSCORES',
    'LIMIT',
    0,
    20
  );
  const vBrowserUIDs = await redis?.zrevrangebyscore(
    'vBrowserUIDs',
    '+inf',
    '0',
    'WITHSCORES',
    'LIMIT',
    0,
    20
  );
  const vBrowserClientIDMinutes = await redis?.zrevrangebyscore(
    'vBrowserClientIDMinutes',
    '+inf',
    '0',
    'WITHSCORES',
    'LIMIT',
    0,
    20
  );
  const vBrowserUIDMinutes = await redis?.zrevrangebyscore(
    'vBrowserUIDMinutes',
    '+inf',
    '0',
    'WITHSCORES',
    'LIMIT',
    0,
    20
  );
  const vBrowserClientIDsCard = await redis?.zcard('vBrowserClientIDs');
  const vBrowserUIDsCard = await redis?.zcard('vBrowserUIDs');

  let vmManagerStats = null;
  try {
    vmManagerStats = (
      await axios.get('http://localhost:' + config.VMWORKER_PORT + '/stats')
    ).data;
  } catch (e) {
    console.warn(e);
  }
  const createRoomPreloads = await getRedisCountDay('createRoomPreload');

  return {
    currentRoomCount,
    currentRoomSizeCounts,
    currentUsers,
    currentVBrowser,
    currentVBrowserLarge,
    currentHttp,
    currentScreenShare,
    currentFileShare,
    currentVideoChat,
    currentVBrowserUIDCounts,
    currentUptime,
    currentMemUsage,
    cpuUsage,
    redisUsage,
    postgresUsage,
    vBrowserWaiting,
    numPermaRooms,
    numSubs,
    discordBotWatch,
    createRoomErrors,
    createRoomPreloads,
    deleteAccounts,
    chatMessages,
    addReactions,
    urlStarts,
    playlistAdds,
    screenShareStarts,
    fileShareStarts,
    mediasoupStarts,
    subUploads,
    subDownloadsOS,
    subSearchesOS,
    youtubeSearch,
    videoChatStarts,
    connectStarts,
    connectStartsDistinct,
    hetznerApiRemaining,
    vBrowserStarts,
    vBrowserLaunches,
    vBrowserFails,
    vBrowserStagingFails,
    vBrowserStopManual,
    vBrowserStopEmpty,
    vBrowserStopTimeout,
    recaptchaRejectsLowScore,
    recaptchaRejectsOther,
    vmManagerStats,
    vBrowserStartMS,
    vBrowserStageRetries,
    vBrowserStageFails,
    vBrowserSessionMS,
    // vBrowserVMLifetime,
    vBrowserClientIDs,
    vBrowserClientIDsCard,
    vBrowserClientIDMinutes,
    vBrowserUIDs,
    vBrowserUIDsCard,
    vBrowserUIDMinutes,
    currentRoomData,
  };
}

function computeOpenSubtitlesHash(first: Buffer, last: Buffer, size: number) {
  // console.log(first.length, last.length, size);
  let temp = BigInt(size);
  process(first);
  process(last);

  temp = temp & BigInt('0xffffffffffffffff');
  return temp.toString(16).padStart(16, '0');

  function process(chunk: Buffer) {
    for (let i = 0; i < chunk.length; i += 8) {
      const long = chunk.readBigUInt64LE(i);
      temp += long;
    }
  }
}
