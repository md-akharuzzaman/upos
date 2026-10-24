'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MIGRATIONS, pendingMigrations, validateMigrations } = require('../src/migrations');
const { loadConfig } = require('../src/config');
const { dayWindow } = require('../src/app');

test('migrations are numbered 1..n and non-destructive', () => {
  assert.equal(validateMigrations(), true);
});

test('destructive migrations are rejected (expand/contract rule)', () => {
  assert.throws(() => validateMigrations([{ version: 1, name: 'bad', sql: 'DROP TABLE dbo.sales' }]), /destructive/);
  assert.throws(() => validateMigrations([{ version: 2, name: 'gap', sql: 'SELECT 1' }]), /expected version 1/);
});

test('pendingMigrations returns only unapplied versions', () => {
  assert.deepEqual(
    pendingMigrations([1]).map((m) => m.version),
    MIGRATIONS.slice(1).map((m) => m.version),
  );
  assert.equal(pendingMigrations(MIGRATIONS.map((m) => m.version)).length, 0);
});

test('config picks the azure store only when SQL is configured', () => {
  assert.equal(loadConfig({}).store, 'memory');
  assert.equal(loadConfig({ SQL_SERVER: 'x.database.windows.net' }).store, 'azure');
  assert.equal(loadConfig({ WEBSITE_SITE_NAME: 'app' }).runningInAzure, true);
  assert.equal(loadConfig({ EURC_ENVIRONMENT: 'prod', EURC_SLOT: 'staging' }).slot, 'staging');
});

test('report day window honours the store time zone', () => {
  assert.deepEqual(dayWindow('2026-10-23', -240), { from: '2026-10-23T04:00:00.000Z', to: '2026-10-24T04:00:00.000Z' });
  assert.throws(() => dayWindow('23/10/2026', 0), /YYYY-MM-DD/);
});
