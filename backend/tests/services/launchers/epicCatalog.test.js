const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

describe('epicCatalog', () => {
  function createTestDb() {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE launchers (id INTEGER PRIMARY KEY, name TEXT, display_name TEXT, enabled INTEGER);
      CREATE TABLE games (id INTEGER PRIMARY KEY, title TEXT, slug TEXT UNIQUE);
      CREATE TABLE game_editions (
        id INTEGER PRIMARY KEY, launcher_id INTEGER, launcher_game_id TEXT,
        title TEXT, game_id INTEGER, owned INTEGER DEFAULT 1,
        epic_namespace TEXT, epic_catalog_id TEXT, sandbox_type TEXT,
        parent_edition_id INTEGER, playtime_minutes INTEGER DEFAULT 0,
        UNIQUE(launcher_id, launcher_game_id)
      );
      CREATE TABLE edition_tiers (
        id INTEGER PRIMARY KEY, game_edition_id INTEGER, tier INTEGER DEFAULT 0,
        is_display_edition INTEGER DEFAULT 0
      );
      INSERT INTO launchers VALUES (1, 'epic', 'Epic Games', 1);
    `);
    return db;
  }

  describe('nestDLC', () => {
    it('should set parent_edition_id for non-PUBLIC items in same namespace', () => {
      const { nestDLC } = require('../../../src/services/launchers/epicCatalog');
      const db = createTestDb();

      db.exec(`
        INSERT INTO game_editions (id, launcher_id, launcher_game_id, title, epic_namespace, sandbox_type) VALUES
          (1, 1, 'base', 'Fortnite', 'ns-fortnite', 'PUBLIC'),
          (2, 1, 'dlc1', 'Live', 'ns-fortnite', 'LIVE'),
          (3, 1, 'dlc2', 'Live', 'ns-fortnite', 'LIVE'),
          (4, 1, 'other', 'Celeste', 'ns-celeste', 'PUBLIC');
      `);

      nestDLC(db, 1);

      const dlc1 = db.prepare('SELECT parent_edition_id FROM game_editions WHERE id = 2').get();
      const dlc2 = db.prepare('SELECT parent_edition_id FROM game_editions WHERE id = 3').get();
      assert.equal(dlc1.parent_edition_id, 1);
      assert.equal(dlc2.parent_edition_id, 1);

      const base = db.prepare('SELECT parent_edition_id FROM game_editions WHERE id = 1').get();
      const celeste = db.prepare('SELECT parent_edition_id FROM game_editions WHERE id = 4').get();
      assert.equal(base.parent_edition_id, null);
      assert.equal(celeste.parent_edition_id, null);

      db.close();
    });

    it('should be idempotent on re-sync', () => {
      const { nestDLC } = require('../../../src/services/launchers/epicCatalog');
      const db = createTestDb();

      db.exec(`
        INSERT INTO game_editions (id, launcher_id, launcher_game_id, title, epic_namespace, sandbox_type) VALUES
          (1, 1, 'base', 'Fortnite', 'ns-fortnite', 'PUBLIC'),
          (2, 1, 'dlc1', 'Live', 'ns-fortnite', 'LIVE');
      `);

      nestDLC(db, 1);
      nestDLC(db, 1); // second call should not break

      const dlc = db.prepare('SELECT parent_edition_id FROM game_editions WHERE id = 2').get();
      assert.equal(dlc.parent_edition_id, 1);

      db.close();
    });

    it('should copy game_id from parent to children', () => {
      const { nestDLC } = require('../../../src/services/launchers/epicCatalog');
      const db = createTestDb();

      db.exec(`
        INSERT INTO games (id, title, slug) VALUES (100, 'Fortnite', 'fortnite');
        INSERT INTO game_editions (id, launcher_id, launcher_game_id, title, epic_namespace, sandbox_type, game_id) VALUES
          (1, 1, 'base', 'Fortnite', 'ns-fortnite', 'PUBLIC', 100),
          (2, 1, 'dlc1', 'Live', 'ns-fortnite', 'LIVE', NULL);
      `);

      nestDLC(db, 1);

      const dlc = db.prepare('SELECT game_id FROM game_editions WHERE id = 2').get();
      assert.equal(dlc.game_id, 100);

      db.close();
    });
  });

  describe('resolveCodenames', () => {
    it('should update titles from catalog API response', async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      const { resolveCodenames } = require('../../../src/services/launchers/epicCatalog');

      const db = createTestDb();
      db.exec(`
        INSERT INTO game_editions (id, launcher_id, launcher_game_id, title, epic_namespace, epic_catalog_id)
          VALUES (1, 1, 'Capsicum', 'Capsicum', 'ns-pepper', 'cat-123');
      `);

      axios.get = async (url) => ({
        data: url.includes('ns-pepper') ? {
          'cat-123': { id: 'cat-123', title: 'Pepper Grinder', namespace: 'ns-pepper' }
        } : {}
      });

      try {
        const mockSession = { access_token: 'test', token_type: 'bearer' };
        await resolveCodenames(db, 1, mockSession);

        const ed = db.prepare('SELECT title FROM game_editions WHERE id = 1').get();
        assert.equal(ed.title, 'Pepper Grinder');
      } finally {
        axios.get = originalGet;
        db.close();
      }
    });

    it('should NOT update titles for real game names', async () => {
      const axios = require('axios');
      const originalGet = axios.get;
      const { resolveCodenames } = require('../../../src/services/launchers/epicCatalog');

      const db = createTestDb();
      db.exec(`
        INSERT INTO game_editions (id, launcher_id, launcher_game_id, title, epic_namespace, epic_catalog_id)
          VALUES (1, 1, '12345', 'Celeste', 'ns-celeste', 'cat-456');
      `);

      axios.get = async (url) => ({
        data: url.includes('ns-celeste') ? {
          'cat-456': { id: 'cat-456', title: 'Celeste', namespace: 'ns-celeste' }
        } : {}
      });

      try {
        const mockSession = { access_token: 'test', token_type: 'bearer' };
        await resolveCodenames(db, 1, mockSession);

        const ed = db.prepare('SELECT title FROM game_editions WHERE id = 1').get();
        assert.equal(ed.title, 'Celeste'); // unchanged
      } finally {
        axios.get = originalGet;
        db.close();
      }
    });

    it('should resolve single-capitalized codenames like Capsicum (REGRESSION)', async () => {
      // REGRESSION: single-capitalized words like Capsicum, Risotto, Amethyst
      // were missed by the old isLikelyCodename heuristic because they look
      // structurally identical to real titles like Celeste
      const axios = require('axios');
      const originalGet = axios.get;
      const { resolveCodenames } = require('../../../src/services/launchers/epicCatalog');

      const db = createTestDb();
      db.exec(`
        INSERT INTO game_editions (id, launcher_id, launcher_game_id, title, epic_namespace, epic_catalog_id)
          VALUES
            (1, 1, 'abc1', 'Risotto', 'ns-risotto', 'cat-r1'),
            (2, 1, 'abc2', 'Amethyst', 'ns-amethyst', 'cat-a1'),
            (3, 1, 'abc3', 'Celeste', 'ns-celeste', 'cat-c1');
      `);

      axios.get = async (url) => {
        if (url.includes('ns-risotto')) return { data: { 'cat-r1': { title: 'Cooking Simulator' } } };
        if (url.includes('ns-amethyst')) return { data: { 'cat-a1': { title: 'Dying Light 2' } } };
        if (url.includes('ns-celeste')) return { data: { 'cat-c1': { title: 'Celeste' } } };
        return { data: {} };
      };

      try {
        await resolveCodenames(db, 1, { access_token: 'test', token_type: 'bearer' });

        assert.equal(db.prepare('SELECT title FROM game_editions WHERE id = 1').get().title, 'Cooking Simulator');
        assert.equal(db.prepare('SELECT title FROM game_editions WHERE id = 2').get().title, 'Dying Light 2');
        assert.equal(db.prepare('SELECT title FROM game_editions WHERE id = 3').get().title, 'Celeste'); // same title, no change
      } finally {
        axios.get = originalGet;
        db.close();
      }
    });

    it('should resolve multi-word codenames like "beaublue production" (REGRESSION)', async () => {
      // REGRESSION: multi-word codenames like "beaublue production" were missed
      // because the single-word check skipped them. Now also catches titles that
      // share no words with the catalog title.
      const axios = require('axios');
      const originalGet = axios.get;
      const { resolveCodenames } = require('../../../src/services/launchers/epicCatalog');

      const db = createTestDb();
      db.exec(`
        INSERT INTO game_editions (id, launcher_id, launcher_game_id, title, epic_namespace, epic_catalog_id)
          VALUES
            (1, 1, 'abc1', 'beaublue production', 'ns-bb', 'cat-bb1'),
            (2, 1, 'abc2', 'The Witcher 3', 'ns-witcher', 'cat-w1');
      `);

      axios.get = async (url) => {
        if (url.includes('ns-bb')) return { data: { 'cat-bb1': { title: 'Spirit of the North' } } };
        if (url.includes('ns-witcher')) return { data: { 'cat-w1': { title: 'The Witcher 3: Wild Hunt' } } };
        return { data: {} };
      };

      try {
        await resolveCodenames(db, 1, { access_token: 'test', token_type: 'bearer' });

        // Multi-word codename with no shared words → resolved
        assert.equal(db.prepare('SELECT title FROM game_editions WHERE id = 1').get().title, 'Spirit of the North');
        // Real title with shared words → NOT changed
        assert.equal(db.prepare('SELECT title FROM game_editions WHERE id = 2').get().title, 'The Witcher 3');
      } finally {
        axios.get = originalGet;
        db.close();
      }
    });
  });
});
