import { Migration } from '@mikro-orm/migrations';

/**
 * G02 초기 스키마. 템플릿 DB(`tpl_g02_<seedHash>`)를 만들 때 한 번 실행된다.
 *
 * - 재고 음수를 막는 CHECK 제약은 **일부러 두지 않는다.** 제약이 있으면 `no-lock`의 초과 판매가
 *   "제약 위반 에러"로 바뀌어 불변식 위반이 DB에 남지 않는다. 정합성은 strategy가 지켜야 하고,
 *   불변식 SQL이 사후에 판정한다.
 * - 원장의 `request_id` 유니크는 둔다(같은 요청이 두 번 기록되면 그건 하네스 버그다).
 */
export class Migration20261007000000_g02_init extends Migration {
  override name = 'Migration20261007000000_g02_init';

  override up(): void {
    this.addSql(`create table if not exists "g02_product" (
      "id" integer primary key,
      "initial_stock" integer not null,
      "stock" integer not null
    );`);

    this.addSql(`create table if not exists "g02_order_ledger" (
      "id" bigserial primary key,
      "request_id" uuid not null,
      "product_id" integer not null,
      "qty" integer not null,
      "result" text not null check ("result" in ('success', 'sold_out')),
      "instance" text not null,
      "txid" bigint not null default pg_current_xact_id()::text::bigint,
      "created_at" timestamptz not null default clock_timestamp()
    );`);
    this.addSql(
      `create unique index if not exists "g02_order_ledger_request_id_uq" on "g02_order_ledger" ("request_id");`,
    );
    this.addSql(
      `create index if not exists "g02_order_ledger_product_id_index" on "g02_order_ledger" ("product_id");`,
    );
  }

  override down(): void {
    this.addSql(`drop table if exists "g02_order_ledger";`);
    this.addSql(`drop table if exists "g02_product";`);
  }
}
