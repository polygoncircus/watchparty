import { Client } from 'pg';
import config from './config';
import { createHash, Hash } from 'crypto';
import { getUserByEmail } from './utils/firebase';
import { insertObject, updateObject } from './utils/postgres';
import { getAllActiveSubscriptions, getAllCustomers } from './utils/stripe';

let lastSubsDigest: String;
let currentSubsDigest: String;
let currentSubsHash: Hash;

const postgres2 = new Client({
  connectionString: config.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
postgres2.connect();

setInterval(syncSubscribers, 60 * 1000);

async function syncSubscribers() {
  if (!config.STRIPE_SECRET_KEY || !config.FIREBASE_ADMIN_SDK_CONFIG) {
    return;
  }
  console.time('syncSubscribers');
  // Fetch subs, customers from stripe
  const [subs, customers] = await Promise.all([
    getAllActiveSubscriptions(),
    getAllCustomers(),
  ]);

  const emailMap = new Map();
  customers.forEach((cust) => {
    emailMap.set(cust.id, cust.email);
  });

  const uidMap = new Map();
  for (let i = 0; i < subs.length; i += 50) {
    // Batch customers and fetch firebase data
    const batch = subs.slice(i, i + 50);
    const fbUsers = await Promise.all(
      batch
        .map((sub) =>
          emailMap.get(sub.customer)
            ? getUserByEmail(emailMap.get(sub.customer))
            : null
        )
        .filter(Boolean)
    );
    fbUsers.forEach((user) => {
      uidMap.set(user?.email, user?.uid);
    });
  }

  // Create sub objects
  const result = subs.map((sub) => ({
    customerId: sub.customer,
    email: emailMap.get(sub.customer),
    status: sub.status,
    uid: uidMap.get(emailMap.get(sub.customer)),
  }));

  // generate hash value over all current sub uids
  currentSubsHash = createHash('md5');
  for (let i = 0; i < result.length; i++) {
    const row = result[i];
    currentSubsHash.update(row.uid);
  }
  currentSubsDigest = currentSubsHash.digest('hex');

  // Upsert to DB
  // console.log(result);
  if (currentSubsDigest !== lastSubsDigest) {
    try {
      await postgres2?.query('BEGIN TRANSACTION');
      await postgres2?.query('DELETE FROM subscriber');
      await postgres2?.query('UPDATE room SET "isSubRoom" = false');
      for (let i = 0; i < result.length; i++) {
        const row = result[i];
        await insertObject(postgres2, 'subscriber', row);
        await updateObject(
          postgres2,
          'room',
          { isSubRoom: true },
          { owner: row.uid }
        );
      }
      await postgres2?.query('COMMIT');
      console.log('%s subscribers', result.length);
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  }
  lastSubsDigest = currentSubsDigest;
  console.timeEnd('syncSubscribers');
}
