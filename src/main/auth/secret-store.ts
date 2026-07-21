/**
 * 자격증명 ① — 백엔드 로그인 토큰 저장소 (스펙 v1.3 §5 "자격증명 2종 구분").
 * Electron `safeStorage`(OS 키체인 키로 암호화)로만 저장하며, 평문으로는 절대 남기지 않는다.
 * ② Anthropic 자격증명은 여기 들어오지 않는다 — `process.env.ANTHROPIC_API_KEY` 전용이다.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { safeStorage } from 'electron';
import { logError } from '@main/util/errors';
import { writeFileAtomic } from '@main/util/fsx';

export interface StoredCredentials {
  token: string;
  email: string;
}

export interface SecretStore {
  read(): Promise<StoredCredentials | null>;
  write(credentials: StoredCredentials): Promise<void>;
  clear(): Promise<void>;
}

/** 암호화가 불가능한 환경(리눅스 키링 부재 등)에서는 메모리에만 둔다 — 평문 저장 금지. */
export class SafeStorageSecretStore implements SecretStore {
  private readonly file: string;
  private memory: StoredCredentials | null = null;

  constructor(userDataDir: string) {
    this.file = path.join(userDataDir, 'auth.bin');
  }

  private get encryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async read(): Promise<StoredCredentials | null> {
    if (this.memory) return this.memory;
    if (!this.encryptionAvailable) return null;
    try {
      const blob = await fs.readFile(this.file);
      const json = safeStorage.decryptString(blob);
      const parsed = JSON.parse(json) as StoredCredentials;
      if (!parsed.token) return null;
      this.memory = parsed;
      return parsed;
    } catch {
      return null; // 파일이 없거나 다른 사용자 계정에서 만든 blob
    }
  }

  async write(credentials: StoredCredentials): Promise<void> {
    this.memory = credentials;
    if (!this.encryptionAvailable) {
      logError('auth', new Error('safeStorage 사용 불가 — 토큰을 이번 실행 동안만 유지합니다.'));
      return;
    }
    const blob = safeStorage.encryptString(JSON.stringify(credentials));
    await writeFileAtomic(this.file, blob);
  }

  async clear(): Promise<void> {
    this.memory = null;
    await fs.rm(this.file, { force: true });
  }
}

/** 테스트·목 모드용 인메모리 저장소. */
export class MemorySecretStore implements SecretStore {
  private value: StoredCredentials | null = null;
  async read(): Promise<StoredCredentials | null> {
    return this.value;
  }
  async write(credentials: StoredCredentials): Promise<void> {
    this.value = credentials;
  }
  async clear(): Promise<void> {
    this.value = null;
  }
}
