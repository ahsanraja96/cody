import 'fake-indexeddb/auto';
import { beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { db } from '@/lib/db';

beforeEach(async () => {
  fakeBrowser.reset();
  db.close();
  await db.delete();
  await db.open();
});
