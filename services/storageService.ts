import { openDB, DBSchema, IDBPDatabase } from 'idb';
import { Paper, DownloadedDocument } from '../types';

interface AcademiaDB extends DBSchema {
    papers: {
        key: string; // URL or Title as key
        value: Paper;
    };
    documents: {
        key: string; // Document ID
        value: DownloadedDocument;
        indexes: { 'by-paper': number }; // Index to find docs for a specific paper
    };
    logs: {
        key: number;
        value: { timestamp: number; message: string; type: 'info' | 'error' | 'success' };
        autoIncrement: true;
    };
    blocked_urls: {
        key: string; // The URL to block
        value: { key: string; timestamp: number; reason: string };
    };
}

const DB_NAME = 'academia_db';
const DB_VERSION = 2; // Increment version for new store

class StorageService {
    private dbPromise: Promise<IDBPDatabase<AcademiaDB>>;

    constructor() {
        this.dbPromise = openDB<AcademiaDB>(DB_NAME, DB_VERSION, {
            upgrade(db, oldVersion, newVersion, transaction) {
                // Papers Store
                if (!db.objectStoreNames.contains('papers')) {
                    db.createObjectStore('papers', { keyPath: 'url' });
                }

                // Documents Store
                if (!db.objectStoreNames.contains('documents')) {
                    const docStore = db.createObjectStore('documents', { keyPath: 'id' });
                    docStore.createIndex('by-paper', 'paperId');
                }

                // Logs Store
                if (!db.objectStoreNames.contains('logs')) {
                    db.createObjectStore('logs', { autoIncrement: true });
                }

                // Blocked URLs Store (New in V2)
                if (!db.objectStoreNames.contains('blocked_urls')) {
                    db.createObjectStore('blocked_urls', { keyPath: 'key' }); // 'key' is the URL
                }
            },
            blocked() {
                console.warn("Database blocked: another tab is open with an older version.");
            },
            blocking() {
                console.warn("Database blocking: newer version waiting.");
            },
            terminated() {
                console.error("Database terminated unexpectedly.");
            },
        }).catch(e => {
            console.warn("Storage Initialization Failed (Access Denied?):", e);
            throw e;
        }) as Promise<IDBPDatabase<AcademiaDB>>;

        // Suppress initial unhandled rejection noise
        this.dbPromise.catch(() => { });
    }

    // --- PAPER OPERATIONS ---

    async savePapers(papers: Paper[]) {
        try {
            const db = await this.dbPromise;
            const tx = db.transaction('papers', 'readwrite');
            const store = tx.objectStore('papers');

            // We use a safe key. Ideally paper.url, but if missing, fallback to title?
            // Let's assume paper.url is good, or generate a hash.
            // For now, we'll try to put them all.
            await Promise.all(
                papers.map(p => {
                    // Ensure unique key exists
                    if (!p.url) p.url = `local-${Date.now()}-${Math.random()}`;
                    return store.put(p)
                })
            );
            await tx.done;
        } catch (e) {
            console.warn("[Storage] savePapers failed (Storage blocked?):", e);
        }
    }

    async getPapers(): Promise<Paper[]> {
        try {
            const db = await this.dbPromise;
            return await db.getAll('papers');
        } catch (e) {
            console.warn("[Storage] getPapers failed:", e);
            return [];
        }
    }

    async clearPapers(): Promise<void> {
        try {
            const db = await this.dbPromise;
            await db.clear('papers');
        } catch (e) { console.warn("[Storage] clearPapers failed:", e); }
    }

    async deletePapers(urls: string[]): Promise<void> {
        try {
            const db = await this.dbPromise;
            const tx = db.transaction('papers', 'readwrite');
            await Promise.all(urls.map(url => tx.store.delete(url)));
            await tx.done;
        } catch (e) { console.warn("[Storage] deletePapers failed:", e); }
    }

    // --- DOCUMENT OPERATIONS ---

    async saveDocument(doc: DownloadedDocument) {
        try {
            const db = await this.dbPromise;
            const tx = db.transaction('documents', 'readwrite');
            await tx.store.put(doc);
            await tx.done;
        } catch (e) { console.warn("[Storage] saveDocument failed:", e); }
    }

    async deleteDocument(id: string) {
        try {
            const db = await this.dbPromise;
            const tx = db.transaction('documents', 'readwrite');
            await tx.store.delete(id);
            await tx.done;
        } catch (e) { console.warn("[Storage] deleteDocument failed:", e); }
    }

    async getAllDocuments(): Promise<DownloadedDocument[]> {
        try {
            const db = await this.dbPromise;
            return await db.getAll('documents');
        } catch (e) {
            console.warn("[Storage] getAllDocuments failed:", e);
            return [];
        }
    }

    async clearDocuments() {
        try {
            const db = await this.dbPromise;
            await db.clear('documents');
        } catch (e) { console.warn("[Storage] clearDocuments failed:", e); }
    }

    // --- LOG OPERATIONS ---
    async addLog(agent: string, message: string, type: 'info' | 'error' | 'success') {
        try {
            const db = await this.dbPromise;
            await db.add('logs', {
                timestamp: Date.now(),
                message: `[${agent}] ${message}`,
                type
            });
        } catch (e) {
            // Squelch log errors to prevent noise
        }
    }

    async blockUrl(url: string, reason: string) {
        try {
            const db = await this.dbPromise;
            await db.put('blocked_urls', {
                key: url,
                timestamp: Date.now(),
                reason
            });
            console.log(`[Storage] Blocked URL: ${url} (${reason})`);
        } catch (e) {
            console.warn("Failed to block URL:", e);
        }
    }

    async isBlocked(url: string): Promise<boolean> {
        try {
            const db = await this.dbPromise;
            const entry = await db.get('blocked_urls', url);
            return !!entry;
        } catch (e) {
            return false;
        }
    }
}

export const storageService = new StorageService();
