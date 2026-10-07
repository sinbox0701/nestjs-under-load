import { Migration } from '@mikro-orm/migrations';

/**
 * G01 초기 스키마. 템플릿 DB(`tpl_g01_<seedHash>`)를 만들 때 한 번 실행된다.
 *
 * - `g01_document.version`에는 CHECK·트리거를 두지 않는다. 낙관 락은 애플리케이션 쪽 조건부 UPDATE 몫이다.
 * - 문서 이력·원장에는 FK를 걸지 않는다(부하 중 INSERT 비용을 strategy 간에 같게 유지, 정합성은 사후 SQL로 판정).
 * - 원장의 `request_id` 유니크는 둔다(같은 요청이 두 번 기록되면 그건 하네스 버그다).
 */
export class Migration20261007000100_g01_init extends Migration {
  override name = 'Migration20261007000100_g01_init';

  override up(): void {
    this.addSql(`create table if not exists "g01_document" (
      "id" integer primary key,
      "version" integer not null default 1,
      "field_a" text[] not null default '{}',
      "field_b" text[] not null default '{}',
      "field_c" text[] not null default '{}',
      "field_d" text[] not null default '{}',
      "field_versions" jsonb not null default '{"a":0,"b":0,"c":0,"d":0}'::jsonb,
      "edit_count" integer not null default 0,
      "locked_by" text null,
      "lease_until" timestamptz null,
      "fence" bigint not null default 0
    );`);

    this.addSql(`create table if not exists "g01_document_revision" (
      "id" bigserial primary key,
      "document_id" integer not null,
      "edit_token" text not null,
      "request_id" uuid not null,
      "base_version" integer not null,
      "version" integer not null,
      "txid" bigint not null default pg_current_xact_id()::text::bigint,
      "created_at" timestamptz not null default clock_timestamp()
    );`);
    this.addSql(
      `create index if not exists "g01_document_revision_document_id_index" on "g01_document_revision" ("document_id");`,
    );

    this.addSql(`create table if not exists "g01_edit_ledger" (
      "id" bigserial primary key,
      "request_id" uuid not null,
      "document_id" integer not null,
      "edit_token" text not null,
      "result" text not null check ("result" in ('success', 'conflict')),
      "instance" text not null,
      "txid" bigint not null default pg_current_xact_id()::text::bigint,
      "created_at" timestamptz not null default clock_timestamp()
    );`);
    this.addSql(
      `create unique index if not exists "g01_edit_ledger_request_id_uq" on "g01_edit_ledger" ("request_id");`,
    );
    this.addSql(
      `create index if not exists "g01_edit_ledger_document_id_index" on "g01_edit_ledger" ("document_id");`,
    );
  }

  override down(): void {
    this.addSql(`drop table if exists "g01_edit_ledger";`);
    this.addSql(`drop table if exists "g01_document_revision";`);
    this.addSql(`drop table if exists "g01_document";`);
  }
}
