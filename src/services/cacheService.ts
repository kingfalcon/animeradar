export interface CachedData<T> {
  data: T;
  timestamp: number;
  ttl: number;
  version: string;
  key: string;
}

export interface CacheOptions {
  ttl?: number;
  version?: string;
}

class CacheService {
  private readonly DB_NAME = 'anime-streaming-cache';
  private readonly DB_VERSION = 1;
  private readonly STORE_NAME = 'cache-store';
  // Short by design. The authoritative cache is now server-side (lib/cache.ts), shared by
  // all visitors; this layer only saves a round trip. A long TTL here is what would keep
  // the 25-title truncation alive in browsers after the fix shipped.
  private readonly DEFAULT_TTL = 60 * 60 * 1000; // 1 hour in milliseconds
  private readonly DEFAULT_VERSION = '1.0.0';
  private db: IDBDatabase | null = null;

  constructor() {
    this.initDB();
  }

  private async initDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onerror = () => {
        console.error('Failed to open IndexedDB');
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          const store = db.createObjectStore(this.STORE_NAME, { keyPath: 'key' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });
  }

  private async ensureDB(): Promise<IDBDatabase> {
    if (!this.db) {
      await this.initDB();
    }
    return this.db!;
  }

  private isExpired(cachedData: CachedData<any>): boolean {
    const now = Date.now();
    return (now - cachedData.timestamp) > cachedData.ttl;
  }

  private isVersionMismatch(cachedData: CachedData<any>, expectedVersion: string): boolean {
    return cachedData.version !== expectedVersion;
  }

  async set<T>(key: string, data: T, options: CacheOptions = {}): Promise<void> {
    try {
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(this.STORE_NAME);

      const cachedData: CachedData<T> = {
        key,
        data,
        timestamp: Date.now(),
        ttl: options.ttl || this.DEFAULT_TTL,
        version: options.version || this.DEFAULT_VERSION
      };

      await new Promise<void>((resolve, reject) => {
        const request = store.put(cachedData);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      console.log(`✓ CACHE: Stored data for key "${key}"`);
    } catch (error) {
      console.error(`❌ CACHE: Failed to store data for key "${key}":`, error);
    }
  }

  async get<T>(key: string, expectedVersion: string = this.DEFAULT_VERSION): Promise<T | null> {
    try {
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], 'readonly');
      const store = transaction.objectStore(this.STORE_NAME);

      const cachedData = await new Promise<CachedData<T> | null>((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });

      if (!cachedData) {
        console.log(`ℹ️  CACHE: No data found for key "${key}"`);
        return null;
      }

      if (this.isExpired(cachedData)) {
        console.log(`⏰ CACHE: Data expired for key "${key}"`);
        await this.delete(key);
        return null;
      }

      if (this.isVersionMismatch(cachedData, expectedVersion)) {
        console.log(`🔄 CACHE: Version mismatch for key "${key}"`);
        await this.delete(key);
        return null;
      }

      const age = Date.now() - cachedData.timestamp;
      const remainingTTL = cachedData.ttl - age;
      console.log(`✓ CACHE: Retrieved data for key "${key}" (${Math.round(remainingTTL / 1000 / 60)} minutes remaining)`);
      
      return cachedData.data;
    } catch (error) {
      console.error(`❌ CACHE: Failed to retrieve data for key "${key}":`, error);
      return null;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(this.STORE_NAME);

      await new Promise<void>((resolve, reject) => {
        const request = store.delete(key);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      console.log(`🗑️  CACHE: Deleted data for key "${key}"`);
    } catch (error) {
      console.error(`❌ CACHE: Failed to delete data for key "${key}":`, error);
    }
  }

  async clear(): Promise<void> {
    try {
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(this.STORE_NAME);

      await new Promise<void>((resolve, reject) => {
        const request = store.clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      console.log('🧹 CACHE: Cleared all cache data');
    } catch (error) {
      console.error('❌ CACHE: Failed to clear cache:', error);
    }
  }

  async cleanup(): Promise<void> {
    try {
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], 'readwrite');
      const store = transaction.objectStore(this.STORE_NAME);

      const request = store.openCursor();
      let cleanedCount = 0;

      await new Promise<void>((resolve, reject) => {
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const cachedData = cursor.value as CachedData<any>;
            if (this.isExpired(cachedData)) {
              cursor.delete();
              cleanedCount++;
            }
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => reject(request.error);
      });

      if (cleanedCount > 0) {
        console.log(`🧹 CACHE: Cleaned up ${cleanedCount} expired entries`);
      }
    } catch (error) {
      console.error('❌ CACHE: Failed to cleanup expired entries:', error);
    }
  }

  async getStats(): Promise<{
    totalEntries: number;
    expiredEntries: number;
    totalSize: number;
  }> {
    try {
      const db = await this.ensureDB();
      const transaction = db.transaction([this.STORE_NAME], 'readonly');
      const store = transaction.objectStore(this.STORE_NAME);

      const request = store.openCursor();
      let totalEntries = 0;
      let expiredEntries = 0;
      let totalSize = 0;

      await new Promise<void>((resolve, reject) => {
        request.onsuccess = (event) => {
          const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
          if (cursor) {
            const cachedData = cursor.value as CachedData<any>;
            totalEntries++;
            totalSize += JSON.stringify(cachedData).length;
            
            if (this.isExpired(cachedData)) {
              expiredEntries++;
            }
            
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = () => reject(request.error);
      });

      return { totalEntries, expiredEntries, totalSize };
    } catch (error) {
      console.error('❌ CACHE: Failed to get stats:', error);
      return { totalEntries: 0, expiredEntries: 0, totalSize: 0 };
    }
  }

  // Helper method to generate cache keys
  static generateKey(type: 'anime-basic-v2' | 'streaming-batch' | 'streaming-anime', params: Record<string, any>): string {
    switch (type) {
      // v2: v1 keys hold the truncated 25-title lists from before season pagination
      // existed. Renaming the key retires them instead of waiting out their TTL.
      case 'anime-basic-v2':
        return `anime-basic-v2-${params.season}-${params.year}`;
      case 'streaming-batch':
        return `streaming-batch-${params.season}-${params.year}`;
      case 'streaming-anime':
        return `streaming-anime-${params.malId}`;
      default:
        return `cache-${JSON.stringify(params)}`;
    }
  }
}

export { CacheService };
export const cacheService = new CacheService(); 