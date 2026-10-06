-- G02 불변식. DB에 남은 사실(g02_product, g02_order_ledger)만으로 판정한다(DESIGN §3 원칙 1).
-- 규약: `-- name: <id>` 로 시작하는 구간 하나가 쿼리 하나. 각 쿼리는 `violations` 열 1개·행 1개를 반환하고 0이어야 통과.
--       severity: info 쿼리는 판정이 아니라 대조용 값을 반환한다(manifest 참조).
-- 전제: 실행 중 initial_stock은 바뀌지 않는다. 원장은 성공·품절만 남고 실패(예외·롤백)는 남지 않는다.

-- name: no_oversell
-- 초과 판매: 원장 성공 수량 합이 초기 재고를 넘은 상품 수.
-- 잃어버린 갱신이 나면 재고가 음수가 아니어도 초과 판매될 수 있다(재고 1개에 성공 2건, 둘 다 stock=0을 씀).
select count(*)::int as violations
from (
  select p.id
  from g02_product p
  join g02_order_ledger l on l.product_id = p.id and l.result = 'success'
  group by p.id, p.initial_stock
  having sum(l.qty) > p.initial_stock
) oversold;

-- name: no_negative_stock
-- 재고 음수: 현재 재고가 0보다 작은 상품 수. 스키마에 CHECK 제약을 일부러 두지 않았으므로 strategy가 지켜야 한다.
select count(*)::int as violations
from g02_product
where stock < 0;

-- name: sold_equals_decrement
-- 원장 합계 = 초기 재고 − 최종 재고: 이 등식이 깨진 상품 수.
-- 잃어버린 갱신이면 실제 차감량(initial_stock - stock) < 원장 성공 수량 합이 된다.
-- 원장에 없는 차감(원장 없이 커밋된 UPDATE)이면 반대로 실제 차감량이 더 크다. 둘 다 위반.
select count(*)::int as violations
from g02_product p
left join (
  select product_id, sum(qty) as sold
  from g02_order_ledger
  where result = 'success'
  group by product_id
) l on l.product_id = p.id
where p.initial_stock - p.stock <> coalesce(l.sold, 0);

-- name: no_duplicate_request_id
-- 중복 요청 ID: 원장에 두 번 이상 기록된 request_id 수. 요청 1건 = 원장 1행이어야 한다.
-- 유니크 인덱스가 막고 있으므로 0이 아니면 스키마나 하네스가 잘못된 것이다.
select count(*)::int as violations
from (
  select request_id
  from g02_order_ledger
  group by request_id
  having count(*) > 1
) dup;

-- name: ledger_counts
-- 보조 대조(info): 원장 결과별 행 수. run.mjs가 k6 성공/품절 수와 비교한다.
-- k6 쪽이 적으면 "클라이언트 타임아웃 후 서버 커밋" 가능성.
select
  count(*) filter (where result = 'success')::int as success,
  count(*) filter (where result = 'sold_out')::int as sold_out,
  count(*)::int as total
from g02_order_ledger;
