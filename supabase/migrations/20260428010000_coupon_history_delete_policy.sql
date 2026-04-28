-- coupon_history 의 DELETE RLS 정책 추가
-- 클라이언트(anon)가 외부 API 의 활성 쿠폰 목록과 비교해 stale row 를 정리할 수 있게 한다.
-- 데이터 성격: 단순 시도/수령 기록이라 anon 삭제 허용해도 운영 영향 작음.

CREATE POLICY "coupon_history_delete" ON coupon_history FOR DELETE USING (true);
