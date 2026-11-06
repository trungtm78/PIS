# Báo cáo UAT — uat-test-runner

Chạy lúc 2026-11-07T01:07:05+07:00

```
VERDICT: NO-GO
TỔNG: 25 | ĐẠT: 25 | HỎNG: 0 | BỎ QUA: 0 | CHẬP CHỜN: 0 | HEAL: 9
KHUYẾT PHÉP ĐO: G0 (Entry), G4 (Defect budget), G6 (Non-functional), G7 (Sign-off record) — không đo được nên KHÔNG được coi là đạt; cần người xác nhận.
CỔNG: G0=KHÔNG ĐO ĐƯỢC · G1=KHÔNG ÁP · G2=HỎNG · G3=HỎNG · G4=CẦN NGƯỜI · G5=KHÔNG ÁP · G6=KHÔNG ĐO ĐƯỢC · G7=CẦN NGƯỜI
```

| Cổng | Tên | Trạng thái | Chi tiết | Hệ quả |
|---|---|---|---|---|
| G0 | Entry | KHÔNG ĐO ĐƯỢC | không có url.json (resolve_url.py) | HẠ TRẦN |
| G1 | API smoke | KHÔNG ÁP | bộ ca không có lớp api |  |
| G2 | Critical path | HỎNG | 34/51 ca đường găng không đạt: TC-UI-MOB-06(không chạy), TC-UI-MOB-13(không chạy), TC-UI-MOB-14(không chạy), TC-UI-MOB-15(không chạy), TC-UI-MOB-16(không chạy), TC-UI-MOB-17(không chạy), TC-UI-MOB-18(không chạy), TC-UI-MOB-19(không chạy), TC-UI-MOB-20(không chạy), TC-UI-MOB-21(không chạy) | NO-GO |
| G3 | Coverage | HỎNG | 25/88 = 28.4% < 95% | NO-GO |
| G4 | Defect budget | CẦN NGƯỜI | 0 lỗi S2 mở, nhưng ngưỡng S2 chưa do người đặt (--s2-budget) — không bịa ngưỡng rồi tuyên bố đạt | HẠ TRẦN |
| G5 | Regression | KHÔNG ÁP | không có baseline do người chỉ định (kỹ năng không bao giờ tự chọn baseline) |  |
| G6 | Non-functional | KHÔNG ĐO ĐƯỢC | chưa có hiện vật a11y/perf (--a11y/--perf) | HẠ TRẦN |
| G7 | Sign-off record | CẦN NGƯỜI | chưa có hồ sơ ký duyệt (người duyệt + bằng chứng + thời điểm) | HẠ TRẦN |

> G1 ở đây là **API smoke**, khác nghĩa G1 của `uat-test-only` ("mọi lớp có ca đều chạy được") — xem handoff-schema §7.
> Kết quả của `uat-test-runner` **không dùng để ký nghiệm thu**: skill này được phép sửa mã. Muốn ký thì chạy `uat-test-only` trên một lượt mới.
