-- G01 불변식. DB에 남은 사실(g01_document, g01_edit_ledger, g01_document_revision)만으로 판정한다(DESIGN §3 원칙 1).
-- 규약: `-- name: <id>` 로 시작하는 구간 하나가 쿼리 하나. 각 쿼리는 `violations` 열 1개·행 1개를 반환하고 0이어야 통과.
--       info 쿼리(ledger_counts)는 판정이 아니라 대조용 값을 반환한다.
-- 전제: 원장은 성공한 수정만 남기고(충돌·예외는 롤백) 문서 UPDATE와 같은 트랜잭션에서 기록된다.

-- name: no_lost_update
-- 잃어버린 갱신: 원장 success 수정 토큰 중 최종 문서 필드(a~d)에 없는 수.
-- 편집 모델은 "읽은 배열 뒤에 자기 토큰을 붙여 저장"이므로, 서버가 성공이라고 한 수정의 토큰은 최종 문서에 남아 있어야 한다.
select count(*)::int as violations
from g01_edit_ledger l
left join g01_document d on d.id = l.document_id
where l.result = 'success'
  and (d.id is null or not (l.edit_token = any(d.field_a || d.field_b || d.field_c || d.field_d)));

-- name: edit_count_matches_ledger
-- 문서의 edit_count = 그 문서의 원장 success 행 수: 이 등식이 깨진 문서 수.
-- 원장 없이 커밋된 문서 변경이나 문서 변경 없이 남은 원장 행이 있으면 위반이다.
select count(*)::int as violations
from g01_document d
left join (
  select document_id, count(*) as n
  from g01_edit_ledger
  where result = 'success'
  group by document_id
) l on l.document_id = d.id
where d.edit_count <> coalesce(l.n, 0);

-- name: revision_matches_ledger
-- 문서 이력 행 수 = 원장 success 행 수: 두 수의 차이(절댓값).
-- 둘은 같은 트랜잭션에서 함께 INSERT 되므로 어긋나면 기록 경로가 깨진 것이다.
select abs(
  (select count(*) from g01_document_revision) -
  (select count(*) from g01_edit_ledger where result = 'success')
)::int as violations;

-- name: no_duplicate_request_id
-- 중복 요청 ID: 원장에 두 번 이상 기록된 request_id 수. 요청 1건 = 원장 1행이어야 한다.
-- 유니크 인덱스가 막고 있으므로 0이 아니면 스키마나 하네스가 잘못된 것이다.
select count(*)::int as violations
from (
  select request_id
  from g01_edit_ledger
  group by request_id
  having count(*) > 1
) dup;

-- name: ledger_counts
-- 보조 대조(info): 원장 행 수. run.mjs·실행기가 k6 성공 응답 수와 비교한다.
-- k6 쪽이 적으면 "클라이언트 타임아웃 후 서버 커밋" 가능성.
select
  count(*) filter (where result = 'success')::int as success,
  count(*)::int as total
from g01_edit_ledger;
