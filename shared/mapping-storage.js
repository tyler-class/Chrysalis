/**
 * Mapping storage helpers.
 *
 * Chrome sync storage has an 8KB per-item quota. A user's complete mapping set
 * can exceed that, so mappings are stored across bounded chunk keys while still
 * reading the original single-key format for older installs.
 */
(function (global) {
  const LEGACY_KEY = 'accountMappings';
  const META_KEY = 'accountMappingsStorage';
  const CHUNK_PREFIX = 'accountMappingsChunk.';
  const SYNC_ITEM_LIMIT_BYTES = 8192;
  const CHUNK_TARGET_BYTES = 7600;
  const CURRENT_VERSION = 1;

  function byteLength(str) {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(str).length;
    }
    return unescape(encodeURIComponent(str)).length;
  }

  function storageItemBytes(key, value) {
    return byteLength(key) + byteLength(JSON.stringify(value));
  }

  function chunkKey(index) {
    return CHUNK_PREFIX + index;
  }

  function createIncompleteMappingsError(missingKeys) {
    const err = new Error(
      'Saved account mappings are incomplete. Reload after Chrome Sync finishes, or restore from a backup.'
    );
    err.code = 'INCOMPLETE_MAPPING_STORAGE';
    err.missingKeys = missingKeys;
    return err;
  }

  function getSyncStorage(storageArea) {
    if (storageArea) return storageArea;
    if (!global.chrome || !global.chrome.storage || !global.chrome.storage.sync) {
      throw new Error('Chrome sync storage is not available.');
    }
    return global.chrome.storage.sync;
  }

  async function getPreviousChunkCount(storageArea) {
    const stored = await storageArea.get([META_KEY]);
    const meta = stored && stored[META_KEY];
    return meta && Number.isInteger(meta.chunkCount) && meta.chunkCount > 0
      ? meta.chunkCount
      : 0;
  }

  function buildChunks(mappings) {
    const rows = Array.isArray(mappings) ? mappings : [];
    const chunks = [];
    let current = [];

    for (const row of rows) {
      const candidateSingle = [row];
      if (storageItemBytes(chunkKey(chunks.length), candidateSingle) > SYNC_ITEM_LIMIT_BYTES) {
        throw new Error('One mapping row is too large to store in Chrome sync storage.');
      }

      const candidate = current.concat([row]);
      if (
        current.length > 0 &&
        storageItemBytes(chunkKey(chunks.length), candidate) > CHUNK_TARGET_BYTES
      ) {
        chunks.push(current);
        current = [row];
      } else {
        current = candidate;
      }
    }

    if (current.length > 0) chunks.push(current);
    return chunks;
  }

  async function loadMappings(storageArea) {
    const syncStorage = getSyncStorage(storageArea);
    const stored = await syncStorage.get([META_KEY, LEGACY_KEY]);
    const legacyMappings = Array.isArray(stored && stored[LEGACY_KEY])
      ? stored[LEGACY_KEY]
      : [];
    const meta = stored && stored[META_KEY];

    if (!meta || !Number.isInteger(meta.chunkCount)) {
      return legacyMappings;
    }

    if (meta.chunkCount <= 0) return [];

    const keys = Array.from({ length: meta.chunkCount }, (_, i) => chunkKey(i));
    const chunksByKey = await syncStorage.get(keys);
    const mappings = [];

    const missingKeys = [];
    for (const key of keys) {
      const chunk = chunksByKey && chunksByKey[key];
      if (!Array.isArray(chunk)) {
        missingKeys.push(key);
        continue;
      }
      mappings.push(...chunk);
    }

    if (missingKeys.length > 0) {
      if (legacyMappings.length > 0) return legacyMappings;
      throw createIncompleteMappingsError(missingKeys);
    }

    return mappings;
  }

  async function saveMappings(mappings, storageArea) {
    const syncStorage = getSyncStorage(storageArea);
    const chunks = buildChunks(mappings);
    const previousChunkCount = await getPreviousChunkCount(syncStorage);
    const values = {
      [META_KEY]: {
        version: CURRENT_VERSION,
        chunkCount: chunks.length,
        updatedAt: Date.now(),
      },
    };

    chunks.forEach((chunk, index) => {
      values[chunkKey(index)] = chunk;
    });

    await syncStorage.set(values);

    const staleKeys = [LEGACY_KEY];
    for (let i = chunks.length; i < previousChunkCount; i += 1) {
      staleKeys.push(chunkKey(i));
    }
    try {
      await syncStorage.remove(staleKeys);
    } catch (e) {
      try {
        console.warn('[Chrysalis] Saved mappings, but failed to clean up stale mapping storage keys:', e);
      } catch (_) {}
    }
  }

  global.ChrysalisMappingStorage = {
    LEGACY_KEY,
    META_KEY,
    CHUNK_PREFIX,
    loadMappings,
    saveMappings,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
