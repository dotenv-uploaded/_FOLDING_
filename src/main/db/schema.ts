/**
 * SQLite 스키마 — 멱등 마이그레이션 (스펙 v1.3 §1 L2 "상태는 SQLite").
 * `PRAGMA user_version` 으로 단계를 관리하므로 몇 번을 실행해도 안전하다.
 */

/** 각 원소가 하나의 마이그레이션 단계. 배열 끝에만 추가할 것. */
export const MIGRATIONS: string[] = [
  // v1 — 폴더·파일·빌드·대화·메시지
  `
  CREATE TABLE IF NOT EXISTS roots (
    id             TEXT PRIMARY KEY,
    path           TEXT NOT NULL UNIQUE,
    included_count INTEGER NOT NULL DEFAULT 0,
    excluded_count INTEGER NOT NULL DEFAULT 0,
    added_at       TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    root_id   TEXT NOT NULL,
    rel_path  TEXT NOT NULL,
    abs_path  TEXT NOT NULL,
    sha256    TEXT NOT NULL DEFAULT '',
    size      INTEGER NOT NULL DEFAULT 0,
    mtime     TEXT NOT NULL DEFAULT '',
    status    TEXT NOT NULL DEFAULT 'pending',
    dirty     INTEGER NOT NULL DEFAULT 1,
    deleted   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (root_id, rel_path)
  );
  CREATE INDEX IF NOT EXISTS idx_files_dirty ON files (dirty);

  CREATE TABLE IF NOT EXISTS builds (
    id              TEXT PRIMARY KEY,
    status          TEXT NOT NULL,
    progress        INTEGER NOT NULL DEFAULT 0,
    message         TEXT NOT NULL DEFAULT '',
    error           TEXT,
    artifact_sha256 TEXT,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS conversations (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    role            TEXT NOT NULL,
    text            TEXT NOT NULL DEFAULT '',
    citations       TEXT,
    tools           TEXT,
    streaming       INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,

  // v2 — 로컬 파이프라인 전환 (스펙 v1.4).
  // 산출물 해시(artifact_sha256)는 더 이상 쓰지 않는다: 산출물이 네트워크를 건너오지 않으므로
  // 검증 대상이 "받은 바이트"에서 "조립 결과 스키마"로 바뀌었다. 컬럼은 nullable 로 남겨 두고
  // 대신 enrichment 보류 목록을 기록한다 (스펙 v1.4 §5 부분 실패).
  `
  ALTER TABLE builds ADD COLUMN deferred TEXT;
  `,
];
