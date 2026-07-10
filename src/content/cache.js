  function hashText(text) {
    let h1 = 0xdeadbeef;
    let h2 = 0x41c6ce57;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 =
      Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
      Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 =
      Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
      Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  function pageCacheScope() {
    return `${location.hostname}${location.pathname}`;
  }

  function pageCachePrefix() {
    return `${PERSISTENT_CACHE_KEY_PREFIX}${hashText(pageCacheScope())}:`;
  }

  function clearPagePersistentCache() {
    activeSession?.translationCache.clear();
    const storage = chrome?.storage?.local;
    if (!storage) {
      return Promise.resolve();
    }
    const prefix = pageCachePrefix();
    const cleared = persistentCacheWriteChain.then(() =>
      removePagePersistentEntries(storage, prefix)
    );
    persistentCacheWriteChain = cleared.catch(() => {});
    return cleared;
  }

  async function removePagePersistentEntries(storage, prefix) {
    const indexResult = await storage.get(PERSISTENT_CACHE_INDEX_KEY);
    const index = Array.isArray(indexResult?.[PERSISTENT_CACHE_INDEX_KEY])
      ? indexResult[PERSISTENT_CACHE_INDEX_KEY]
      : [];
    const pageKeys = index.filter((key) => key.startsWith(prefix));
    if (pageKeys.length === 0) {
      return;
    }
    await storage.set({
      [PERSISTENT_CACHE_INDEX_KEY]: index.filter(
        (key) => !key.startsWith(prefix)
      )
    });
    await storage.remove(pageKeys);
  }

  function persistentCacheKey(targetLanguage, groupKey) {
    return `${pageCachePrefix()}${hashText(
      `${pageCacheScope()}\u0000${targetLanguage}\u0000${groupKey}`
    )}`;
  }

  async function hydratePersistentCache(session, groups) {
    const storage = chrome?.storage?.local;
    if (!storage) {
      return;
    }
    const targetLanguage = session.settings.targetLanguage;
    const lookup = new Map();
    for (const group of groups) {
      if (session.translationCache.has(group.key)) {
        continue;
      }
      lookup.set(persistentCacheKey(targetLanguage, group.key), group.key);
    }
    if (lookup.size === 0) {
      return;
    }

    let stored;
    try {
      stored = await storage.get([...lookup.keys()]);
    } catch (_error) {
      return;
    }
    for (const [storageKey, groupKey] of lookup) {
      const text = stored?.[storageKey];
      if (typeof text === "string" && text) {
        session.translationCache.set(groupKey, text);
      }
    }
  }

  function queuePersistentCacheWrite(session, groupKey, translatedText) {
    const storage = chrome?.storage?.local;
    if (!storage) {
      return;
    }
    const storageKey = persistentCacheKey(
      session.settings.targetLanguage,
      groupKey
    );
    persistentCacheWriteChain = persistentCacheWriteChain
      .then(() =>
        writePersistentCacheEntry(storage, storageKey, translatedText)
      )
      .catch(() => {});
  }

  async function writePersistentCacheEntry(storage, storageKey, text) {
    const indexResult = await storage.get(PERSISTENT_CACHE_INDEX_KEY);
    const index = Array.isArray(indexResult?.[PERSISTENT_CACHE_INDEX_KEY])
      ? indexResult[PERSISTENT_CACHE_INDEX_KEY]
      : [];
    const nextIndex = index.filter((key) => key !== storageKey);
    nextIndex.push(storageKey);

    const evicted = [];
    while (nextIndex.length > PERSISTENT_CACHE_MAX_ENTRIES) {
      evicted.push(nextIndex.shift());
    }

    await storage.set({
      [storageKey]: text,
      [PERSISTENT_CACHE_INDEX_KEY]: nextIndex
    });
    if (evicted.length > 0) {
      await storage.remove(evicted);
    }
  }
