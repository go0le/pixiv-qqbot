/**
 * Pixiv 动态标签映射存储库 (自学习映射表)
 *
 * 管理运行时通过 LLM 语义分析自动学习并沉淀的标签映射。
 * 支持：
 * - 内存 LRU/容量约束 (默认最大 2000 条)
 * - 磁盘原子持久化 (.tmp 写入 + rename)
 * - 灾备恢复 (损坏时从 .bak 恢复)
 * - 大小写与首尾空白归一化
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface DynamicTagStoreConfig {
  filePath: string;
  maxEntries?: number;
}

export class DynamicTagStore {
  public readonly filePath: string;
  private readonly backupPath: string;
  private readonly maxEntries: number;
  private map: Map<string, string[]> = new Map();
  private dirty = false;
  private isSaving = false;

  public constructor(config: DynamicTagStoreConfig) {
    this.filePath = config.filePath;
    this.backupPath = `${this.filePath}.bak`;
    this.maxEntries = config.maxEntries ?? 2000;
    this.load();
  }

  /**
   * 标准化存储键名 (含 Unicode NFKC 标准化)
   */
  private normalizeKey(key: string): string {
    return key.normalize('NFKC').trim().toLowerCase();
  }

  /**
   * 查询映射
   */
  public get(key: string): string[] | undefined {
    const norm = this.normalizeKey(key);
    return this.map.get(norm);
  }

  /**
   * 检查是否已有映射
   */
  public has(key: string): boolean {
    const norm = this.normalizeKey(key);
    return this.map.has(norm);
  }

  /**
   * 写入映射（如果超过上限淘汰最早写入项）
   */
  public set(key: string, tags: string | string[]): void {
    const norm = this.normalizeKey(key);
    if (!norm) return;

    const tagList = (Array.isArray(tags) ? tags : [tags])
      .map(t => t.trim())
      .filter(Boolean);

    if (tagList.length === 0) return;

    // 若已存在先删除，保证新设定的排在 Map 末尾（类似 LRU）
    if (this.map.has(norm)) {
      this.map.delete(norm);
    } else if (this.map.size >= this.maxEntries) {
      // 淘汰最老的一项
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        this.map.delete(oldestKey);
      }
    }

    this.map.set(norm, tagList);
    this.dirty = true;
  }

  /**
   * 批量写入映射
   */
  public setBatch(mappings: Record<string, string | string[]>): void {
    for (const [key, val] of Object.entries(mappings)) {
      this.set(key, val);
    }
  }

  /**
   * 获取当前全部映射快照
   */
  public getAll(): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const [k, v] of this.map.entries()) {
      result[k] = [...v];
    }
    return result;
  }

  /**
   * 当前记录数
   */
  public get size(): number {
    return this.map.size;
  }

  /**
   * 从磁盘加载映射表
   */
  public load(): void {
    this.map.clear();
    this.dirty = false;

    if (this.tryLoadFile(this.filePath)) {
      return;
    }

    if (existsSync(this.backupPath) && this.tryLoadFile(this.backupPath)) {
      try {
        copyFileSync(this.backupPath, this.filePath);
      } catch {
        // ignore
      }
    }
  }

  private tryLoadFile(targetPath: string): boolean {
    if (!existsSync(targetPath)) return false;
    try {
      const raw = readFileSync(targetPath, 'utf8');
      const data = JSON.parse(raw);
      if (typeof data !== 'object' || data === null) return false;

      for (const [k, v] of Object.entries(data)) {
        if (typeof k === 'string' && k.trim()) {
          const norm = this.normalizeKey(k);
          if (Array.isArray(v)) {
            const list = v.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()));
            if (list.length > 0) {
              this.map.set(norm, list);
            }
          } else if (typeof v === 'string' && v.trim()) {
            this.map.set(norm, [v.trim()]);
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 持久化到磁盘（原子写入 + 灾备备份 + tmp 残留清理 F-04 + 并发防踩踏 F-11）
   */
  public save(): void {
    if (!this.dirty || this.isSaving) return;
    this.isSaving = true;

    let tmpPath = '';
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }

      // 如果主文件已存在，先制作 .bak 容灾备份
      if (existsSync(this.filePath)) {
        try {
          copyFileSync(this.filePath, this.backupPath);
        } catch {
          // ignore
        }
      }

      const obj: Record<string, string[]> = {};
      for (const [k, v] of this.map.entries()) {
        obj[k] = v;
      }

      const serialized = JSON.stringify(obj, null, 2);
      tmpPath = `${this.filePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
      writeFileSync(tmpPath, serialized, 'utf8');
      renameSync(tmpPath, this.filePath);
      this.dirty = false;
    } catch (err) {
      if (tmpPath && existsSync(tmpPath)) {
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
      }
      console.warn(`[DynamicTagStore] Failed to save dynamic tags to ${this.filePath}:`, err);
    } finally {
      this.isSaving = false;
    }
  }

  /**
   * 清理全部映射（测试及重置用）
   */
  public clear(): void {
    this.map.clear();
    this.dirty = true;
    this.save();
  }
}
