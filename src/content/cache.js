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

  function pageCachePrefix(scope = pageCacheScope()) {
    return `${PERSISTENT_CACHE_KEY_PREFIX}${hashText(scope)}:`;
  }

  function pageCacheGenerationPrefix(scope = pageCacheScope()) {
    return `${PERSISTENT_CACHE_GENERATION_KEY_PREFIX}${hashText(scope)}:`;
  }

  function pageCacheGenerationKey(scope, generation) {
    return `${pageCacheGenerationPrefix(scope)}${generation}`;
  }

  function clearPagePersistentCache() {
    activeSession?.translationCache.clear();
    const storage = chrome?.storage?.local;
    if (!storage) {
      return Promise.resolve();
    }
    const scope = pageCacheScope();
    const prefix = pageCachePrefix(scope);
    const nextGeneration = createCacheGeneration();
    const generationKey = pageCacheGenerationKey(scope, nextGeneration);
    const cleared = persistentCacheWriteChain.then(() =>
      removePagePersistentEntries(
        storage,
        prefix,
        generationKey
      )
    );
    persistentCacheWriteChain = cleared.catch(() => {});
    return cleared;
  }

  async function removePagePersistentEntries(
    storage,
    prefix,
    generationKey
  ) {
    // 先换代，再删值。其他标签页稍后完成的旧请求会带旧 generation，
    // 即使它在本次 remove 之后才落盘，也会在自己的写后校验中被删除。
    await storage.set({
      [generationKey]: {
        updatedAt: Date.now()
      }
    });
    const stored = await storage.get(null);
    const pageKeys = Object.keys(stored || {}).filter((key) =>
      key.startsWith(prefix)
    );
    const keysToRemove = [
      ...pageKeys,
      LEGACY_PERSISTENT_CACHE_INDEX_KEY
    ];
    await storage.remove(keysToRemove);
    await prunePersistentCache(storage);
  }

  function createCacheGeneration() {
    return globalThis.crypto?.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function cacheGenerationSignature(stored, generationPrefix) {
    const markerKeys = Object.keys(stored || {})
      .filter((key) => key.startsWith(generationPrefix))
      .sort();
    return markerKeys.length > 0 ? markerKeys.join("\u0000") : "0";
  }

  function persistentCacheKey(
    scope,
    targetLanguage,
    groupKey,
    generation
  ) {
    return `${pageCachePrefix(scope)}${hashText(
      `${scope}\u0000${targetLanguage}\u0000${generation}\u0000${groupKey}`
    )}`;
  }

  function legacyPersistentCacheKey(scope, targetLanguage, groupKey) {
    return `${pageCachePrefix(scope)}${hashText(
      `${scope}\u0000${targetLanguage}\u0000${groupKey}`
    )}`;
  }

  async function hydratePersistentCache(session, groups) {
    const storage = chrome?.storage?.local;
    if (!storage) {
      return;
    }
    const scope = pageCacheScope();
    const generationPrefix = pageCacheGenerationPrefix(scope);
    // 有效期从读操作发起前算，不能在 await 返回后才起算：标签页可能在
    // Promise continuation 运行前休眠，而别的标签页已经完成了 clear。
    const capturedAt = Date.now();
    let stored;
    try {
      stored = await storage.get(null);
    } catch (_error) {
      return;
    }
    const generation = cacheGenerationSignature(stored, generationPrefix);
    session.cacheGenerationCapturedAt = capturedAt;
    session.cacheScope = scope;
    session.cacheGeneration = generation;
    session.cacheGenerationPrefix = generationPrefix;
    const targetLanguage = session.settings.targetLanguage;
    const lookup = new Map();
    for (const group of groups) {
      if (session.translationCache.has(group.key)) {
        continue;
      }
      lookup.set(
        persistentCacheKey(
          scope,
          targetLanguage,
          group.key,
          generation
        ),
        group.key
      );
      if (generation === "0") {
        lookup.set(
          legacyPersistentCacheKey(scope, targetLanguage, group.key),
          group.key
        );
      }
    }
    if (lookup.size === 0) {
      return;
    }

    for (const [storageKey, groupKey] of lookup) {
      if (session.translationCache.has(groupKey)) {
        continue;
      }
      const value = stored?.[storageKey];
      const text = typeof value === "string" ? value : value?.text;
      if (typeof text === "string" && text) {
        session.translationCache.set(groupKey, text);
      }
    }
  }

  function queuePersistentCacheWrite(session, groupKey, translatedText) {
    const storage = chrome?.storage?.local;
    if (
      !storage ||
      !Number.isFinite(session.cacheGenerationCapturedAt)
    ) {
      return;
    }
    const scope = session.cacheScope || pageCacheScope();
    const generation = typeof session.cacheGeneration === "string"
      ? session.cacheGeneration
      : "0";
    const storageKey = persistentCacheKey(
      scope,
      session.settings.targetLanguage,
      groupKey,
      generation
    );
    // 整页翻译会产生上百个缓存值。这里先攒进待写队列：
    // 一次落盘进行中时新到的条目会自动合并到下一次 flush，
    // 避免每个段落都单独触发一次 storage 写入和全局上限检查。
    persistentCachePendingWrites.set(storageKey, {
      text: translatedText,
      generation,
      generationPrefix:
        session.cacheGenerationPrefix || pageCacheGenerationPrefix(scope),
      expiresAt:
        session.cacheGenerationCapturedAt +
        PERSISTENT_CACHE_GENERATION_RETENTION_MS
    });
    persistentCacheWriteChain = persistentCacheWriteChain
      .then(() => flushPersistentCacheWrites(storage))
      .catch(() => {});
  }

  async function flushPersistentCacheWrites(storage) {
    if (persistentCachePendingWrites.size === 0) {
      return;
    }
    const entries = [...persistentCachePendingWrites];
    persistentCachePendingWrites.clear();

    const writtenAt = Date.now();
    await storage.set(Object.fromEntries(
      entries.map(([key, value], index) => [
        key,
        {
          text: value.text,
          generation: hashText(value.generation),
          updatedAt: writtenAt + index / Math.max(entries.length, 1)
        }
      ])
    ));
    await storage.remove(LEGACY_PERSISTENT_CACHE_INDEX_KEY);
    await removeWritesFromStaleGenerations(storage, entries);
    await prunePersistentCache(storage);
  }

  async function removeWritesFromStaleGenerations(storage, entries) {
    const storedGenerations = await storage.get(null);
    const now = Date.now();
    const staleKeys = entries
      .filter(([, value]) =>
        cacheGenerationSignature(
          storedGenerations,
          value.generationPrefix
        ) !== value.generation ||
        now >= value.expiresAt
      )
      .map(([key]) => key);
    if (staleKeys.length > 0) {
      await storage.remove(staleKeys);
    }
  }

  async function prunePersistentCache(storage) {
    const stored = await storage.get(null);
    const cacheEntries = Object.entries(stored || {})
      .filter(([key]) => key.startsWith(PERSISTENT_CACHE_KEY_PREFIX));
    const keysToRemove = new Set();
    if (cacheEntries.length > PERSISTENT_CACHE_MAX_ENTRIES) {
      cacheEntries.sort(([leftKey, leftValue], [rightKey, rightValue]) => {
        const leftUpdatedAt = cacheEntryUpdatedAt(leftValue);
        const rightUpdatedAt = cacheEntryUpdatedAt(rightValue);
        return leftUpdatedAt - rightUpdatedAt ||
          leftKey.localeCompare(rightKey);
      });
      const excess = cacheEntries.length - PERSISTENT_CACHE_MAX_ENTRIES;
      for (const [key] of cacheEntries.slice(0, excess)) {
        keysToRemove.add(key);
      }
    }

    const generationEntries = Object.entries(stored || {}).filter(
      ([key]) => key.startsWith(PERSISTENT_CACHE_GENERATION_KEY_PREFIX)
    );
    const expirationThreshold =
      Date.now() - PERSISTENT_CACHE_GENERATION_RETENTION_MS;
    const invalidatedPageHashes = new Set();
    for (const [generationKey, value] of generationEntries) {
      const markerSuffix = generationKey.slice(
        PERSISTENT_CACHE_GENERATION_KEY_PREFIX.length
      );
      const separatorIndex = markerSuffix.indexOf(":");
      if (
        separatorIndex > 0 &&
        cacheGenerationUpdatedAt(value) <= expirationThreshold
      ) {
        keysToRemove.add(generationKey);
        invalidatedPageHashes.add(markerSuffix.slice(0, separatorIndex));
      }
    }

    // 代际签名由该页仍存活的不可变 marker 集合组成。回收任一 marker
    // 都会改变签名，所以同时删掉该页旧签名下的值，避免留下不可达数据。
    for (const pageHash of invalidatedPageHashes) {
      const pagePrefix = `${PERSISTENT_CACHE_KEY_PREFIX}${pageHash}:`;
      for (const [key] of cacheEntries) {
        if (key.startsWith(pagePrefix)) {
          keysToRemove.add(key);
        }
      }
    }

    if (keysToRemove.size > 0) {
      await storage.remove([...keysToRemove]);
    }
  }

  function cacheEntryUpdatedAt(value) {
    const updatedAt = typeof value === "object" && value
      ? Number(value.updatedAt)
      : 0;
    return Number.isFinite(updatedAt) ? updatedAt : 0;
  }

  function cacheGenerationUpdatedAt(value) {
    // 老版本的纯字符串标记没有可证明的创建时间，保守保留；新版本对象
    // 才参加 TTL 回收，避免升级瞬间误接纳仍在飞行中的 generation=0 写入。
    if (typeof value === "string") {
      return Number.POSITIVE_INFINITY;
    }
    return cacheEntryUpdatedAt(value);
  }
