# Báo cáo UAT — uat-production-demo

Chạy lúc 2026-11-16T06:21:08+07:00 · nguồn ca `uat\run\uat-2026-11-16-production-demo\cases-input.json` · kỹ năng `uat-test-only` (chỉ kiểm và báo cáo, không sửa)

```
VERDICT: FAIL
KẾT LUẬN: BÁO CÁO VÔ HIỆU
TỔNG: 1199 | PASS: 0 | FAIL: 3 | KHÔNG CHẠY: 1196
BUILD: a59c34f04f · URL: https://180-93-34-176.sslip.io:8443 · Playwright 1.62.1 · spec-hash ed445304aeca · rào: VI PHẠM · monkey: web×2
FILE: uat/run/uat-2026-11-16-production-demo/report.md
```

**Rào không-sửa:** mới bẩn: docs/demo-camau/production/16-theo-doi-phe-duyet.png; mới bẩn: docs/demo-camau/production/17-ban-chi-dao.png

## Cổng

| Cổng | Tên | Trạng thái | Chi tiết | Hệ quả |
|---|---|---|---|---|
| G0 | Môi trường | ĐẠT | https://180-93-34-176.sslip.io:8443 → HTTP 200 |  |
| G1 | Lớp chạy | HỎNG | api: lớp 'api' có ca kế hoạch nhưng KHÔNG có kết quả nào; mobile: lớp 'mobile' có ca kế hoạch nhưng KHÔNG có kết quả nào | NO-GO |
| G2 | Đường găng P0/P1 | HỎNG | 1195/1195 ca P0/P1 không đạt: TC-UI-ADM-01(KHÔNG CHẠY), TC-UI-ADM-02(KHÔNG CHẠY), TC-UI-ADM-03(KHÔNG CHẠY), TC-UI-ADM-04(KHÔNG CHẠY), TC-UI-ADM-05(KHÔNG CHẠY), TC-UI-ADM-06(KHÔNG CHẠY), TC-UI-ADM-07(KHÔNG CHẠY), TC-UI-ADM-08(KHÔNG CHẠY), TC-UI-ADM-09(KHÔNG CHẠY), TC-UI-ADM-10(KHÔNG CHẠY), TC-UI-ADM-11(KHÔNG CHẠY), TC-UI-ADM-12(KHÔNG CHẠY) | NO-GO |
| G3 | Độ phủ thực thi | HỎNG | 3/1199 ca đã chạy = 0.3% < 95% | NO-GO |
| G5 | Hồi quy | KHÔNG ÁP | không có baseline do người chỉ định (kỹ năng không bao giờ tự ghi baseline) |  |
| G8 | Độ bền (monkey) | THIẾU MỘT PHẦN | seed 20261116: 125 thao tác · seed 20261117: 121 thao tác · monkey Android chưa chạy: không có thiết bị | HẠ TRẦN |
| G9 | Rào không-sửa | HỎNG | mới bẩn: docs/demo-camau/production/16-theo-doi-phe-duyet.png; mới bẩn: docs/demo-camau/production/17-ban-chi-dao.png | BÁO CÁO VÔ HIỆU |
| G10 | Oracle-binding | ĐẠT | 261/261 ca có assert giá trị neo vào `expected` |  |
| G11 | Chứng âm (negative control) | ĐẠT | cả 3 mệnh đề chắc chắn sai đều đỏ — bộ đo của lượt này có thể bắt lỗi |  |
| G12 | Bằng chứng đủ | HỎNG | 516 ca ĐẠT thiếu bằng chứng: TC-UI-ADM-01(trace), TC-UI-ADM-01(screenshot-final), TC-UI-ADM-02(trace), TC-UI-ADM-02(screenshot-final), TC-UI-ADM-03(trace), TC-UI-ADM-03(screenshot-final), TC-UI-ADM-04(trace), TC-UI-ADM-04(screenshot-final), TC-UI-ADM-05(trace), TC-UI-ADM-05(screenshot-final) | NO-GO |
| G13 | Phủ yêu cầu | HỎNG | 568 yêu cầu chỉ được phủ bởi ca KHÔNG CHẠY (phủ trên giấy): COV-FR-ADM-01, COV-FR-ADM-02, COV-FR-ADM-03, COV-FR-ADM-04, COV-FR-ADM-05, COV-FR-ADM-06, COV-FR-ADM-07, COV-FR-ADM-08 | NO-GO |
| G14 | Ma trận quyền · IDOR | KHÔNG ĐO ĐƯỢC | 20/20 ca không chạy được (khong-co-kich-ban, lop-loi) | HẠ TRẦN |
| G15 | Dữ liệu · Audit · Idempotency · Trạng thái | KHÔNG ĐO ĐƯỢC | 12/12 ca không chạy được (lop-loi) | HẠ TRẦN |
| G16 | Khả năng tiếp cận (đo được) | HỎNG | 262 vi phạm critical/serious: color-contrast@/, color-contrast@adm-01, color-contrast@adm-02, color-contrast@adm-03, color-contrast@adm-04, color-contrast@adm-05, color-contrast@adm-06, color-contrast@adm-07 · axe-core bắt ~57% lỗi a11y theo số lượng; chỉ 29,5% tiêu chí WCAG 2.2 tự động hoá được, 60,2% buộc kiểm thủ công — G16 xanh KHÔNG phải là tuyên bố tuân thủ WCAG 2.2 AA | NO-GO |
| G17 | Hiệu năng (ngân sách người đặt) | KHÔNG ĐO ĐƯỢC | 1/1 ca không chạy được (lop-loi) | HẠ TRẦN |
| G4 | Ngân sách lỗi | CẦN NGƯỜI | ngưỡng S2 cho phép là thoả thuận của người, không có trong hiện vật |  |
| G6 | Phi chức năng | CẦN NGƯỜI | a11y/hiệu năng cần ngân sách do người đặt |  |
| G7 | Ký duyệt | CẦN NGƯỜI | cần người có thẩm quyền ký — AI không bao giờ tự duyệt |  |

## Kết quả theo ca

| Ca | Ưu tiên | Nền tảng | Trạng thái | Lý do / lỗi | Tái hiện | Bằng chứng |
|---|---|---|---|---|---|---|
| TC-AI01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-AI02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-BI01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-BI02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-DQ01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-LIC01 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-MOB01 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-MOB02 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-NOT01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-NOT02 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-OPS01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-OPS02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-SEC01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-SEC02 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-SEC03 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-SEC04 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-SEC05 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-TH01 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-TH02 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-TH03 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-TH04 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-TH05 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-TX01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-TX02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-TX03 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC01 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC02 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC03 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC04 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC05 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC06 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC07 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC08 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC09 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC10 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC100 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC101 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC102 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC103 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC104 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC105 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC106 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC107 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC108 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC11 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC110 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC111 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC112 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC113 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC116 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC117 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC12 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC121 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC126 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC127 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC129 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC130 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC131 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC132 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC134 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC139 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC141 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC143 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC145 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC146 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC147 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC149 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC150 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC153 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC155 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC157 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC159 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC164 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC165 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC175 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC176 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC177 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC180 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC181 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC182 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC183 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC184 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC187 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC195 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC196 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC197 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC200 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC201 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC202 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC203 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC204 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC205 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC206 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC207 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC210 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC212 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC213 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC217 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC220 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC221 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC222 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC223 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC224 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC225 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC226 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC228 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC229 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC230 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC234 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC237 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC238 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC24 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC240 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC241 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC242 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC243 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC244 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC245 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC246 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC247 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC248 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC249 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC250 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC251 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC252 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC253 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC254 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC256 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC257 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC258 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC26 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC264 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC265 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC266 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC267 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC268 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC276 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC277 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC285 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC286 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC287 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC289 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC290 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC291 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC295 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC300 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC301 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC302 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC303 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC304 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC305 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC307 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC308 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC309 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC311 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC312 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC314 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC320 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC321 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC322 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC323 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC324 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC325 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC326 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC327 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC330 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC331 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC332 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC333 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC335 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC338 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC339 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC341 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC344 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC350 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC351 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC352 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC356 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC357 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC36 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC360 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC361 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC368 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC369 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC370 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC376 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC377 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC378 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC379 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC38 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC380 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC386 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC388 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC392 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC396 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC397 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC399 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC400 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC401 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC402 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC403 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC404 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC405 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC406 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC407 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC408 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC409 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC410 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC411 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC413 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC414 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC415 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC417 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC419 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC421 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC424 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC427 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC43 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC430 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC432 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC433 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC434 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC435 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC436 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC437 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC439 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC44 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC440 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC442 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC445 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC446 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC448 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC450 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC454 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC455 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC457 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC458 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC459 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC460 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC461 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC465 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC466 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC467 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC468 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC471 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC472 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC473 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC475 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC478 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC479 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC481 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC485 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC486 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC487 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC488 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC492 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC496 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC500 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC501 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC502 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC503 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC504 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-ACCESSIBILITY-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-AI-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-AI-02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-AI-03 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-AVAILABILITY-02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-AVAILABILITY-03 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-LEGAL-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-LEGAL-02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-OBSERVABILITY-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-OPERABILITY-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-OPERABILITY-02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-OPERABILITY-03 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-OPERABILITY-04 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-OPERABILITY-05 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-OPERABILITY-06 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-PRIVACY-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-PRIVACY-02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-PRIVACY-04 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-SECURITY-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-SECURITY-02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-SECURITY-03 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-SECURITY-04 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-SECURITY-05 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-SECURITY-06 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-SECURITY-07 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-SECURITY-08 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-SECURITY-09 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-SECURITY-10 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-SECURITY-11 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-SECURITY-12 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-TENANCY-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-TENANCY-02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-TENANCY-03 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-TENANCY-04 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-TENANCY-05 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-TENANCY-06 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-TENANCY-07 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-TENANCY-08 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-TENANCY-09 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-03 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-04 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-05 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-06 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-07 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-08 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-09 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-10 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-12 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-13 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-14 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-15 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-16 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-17 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-19 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-20 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-21 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-23 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-24 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-27 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-29 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-31 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-33 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-36 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-39 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-41 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-42 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-43 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-44 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-46 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-54 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-59 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-61 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-63 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-64 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-70 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-73 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-01 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-02 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-03 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-05 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-06 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-07 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-08 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-09 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-10 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-12 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-13 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-15 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-BND-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-BND-02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-BND-03 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-BND-04 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-BND-13 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-CON-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-CON-02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-CON-03 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-IDM-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-IDM-02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-IDM-03 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-KPI-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-LCK-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-NEG-02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-NEG-04 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-NEG-06 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-NEG-08 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-NEG-10 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-OFF-01 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-OFF-02 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-PRC-01 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-PRC-02 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-PRC-03 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-PRC-04 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-PRC-05 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-PRC-06 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-PRC-07 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-PRC-08 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-PRC-09 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-PRC-10 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-REG-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-REG-02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-REG-03 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-SEC-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-SEC-02 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-SEC-03 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-SEC-04 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-SEC-05 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-SEC-06 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-SEC-07 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-SEC-08 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-SEC-09 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-SEC-11 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-STA-01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-ADM-01 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ADM-01-A-85792--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ADM-02 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ADM-02-A-481b2--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ADM-03 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ADM-03-A-3ad1f--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ADM-04 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ADM-04-A-2aaef--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ADM-05 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ADM-05-A-23d96--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ADM-06 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ADM-06-A-4dc12--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ADM-07 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ADM-07-A-0919e--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ADM-08 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ADM-08-A-543e6--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ADM-09 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ADM-09-A-3be2f--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ADM-10 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ADM-10-A-598ce--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ADM-11 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ADM-11-A-389c2--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ADM-12 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ADM-12-A-88afe--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ADM-13 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ADM-13-A-cf95e--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ADM-14 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ADM-14-A-f4784--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ADM-15 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-ADM-16 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-ADM-17 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-ADM-18 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AUD-01 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AUD-02 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AUD-03 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AUD-04 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AUD-05 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AUD-06 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AUD-07 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AUD-08 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AUD-10 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-CAP-01 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CAP-01-C-52c73--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CAP-02 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CAP-02-C-a86d3--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CAP-03 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CAP-03-C-4f513--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CAP-04 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CAP-04-C-6cbe3--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CAP-05 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CAP-05-C-cc863--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CAP-06 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CAP-06-C-42915--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CAP-07 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CAP-07-C-1b8fb--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CAP-08 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CAP-08-C-e819e--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CAP-09 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CAP-09-C-d4142--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CAP-10 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CAP-10-C-3200a--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CAP-11 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CAP-11-C-3f041--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CAP-12 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CAP-12-C-779d4--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CAP-13 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CAP-13-C-70278--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CAP-14 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CAP-14-C-45b5c--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CAP-15 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CAP-15-C-95329--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CAP-16 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-CAP-17 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-CAP-19 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-CAP-20 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DIS-01 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-01-D-1e03e--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-02 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-02-D-19c1e--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-03 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-03-D-10d23--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-04 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-04-D-7d4bd--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-05 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-05-D-97006--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-06 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-06-D-e1222--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-07 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-07-D-a3406--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-08 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-08-D-db535--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-09 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-09-D-8e9c7--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-10 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-10-D-be61a--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-11 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-11-D-30122--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-12 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-12-D-9511b--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-13 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-13-D-c27f1--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-14 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-14-D-fef53--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-15 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-15-D-adab6--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-16 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-16-D-54c5b--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-17 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-17-D-e2739--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-18 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DIS-18-D-874f5--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DIS-19 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DIS-20 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DIS-21 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DIS-22 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DIS-24 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DIS-25 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-01 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-02 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-03 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-04 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-05 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-06 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-07 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-08 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-09 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-10 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-11 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-12 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-13 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-14 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-19 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-21 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-HOME-01 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-HOME-01--bcab6--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-HOME-02 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-HOME-02--da611--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-HOME-03 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-HOME-03--30338--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-HOME-04 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-HOME-04--bf21a--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-HOME-05 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-HOME-05--f2446--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-HOME-06 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-HOME-06--7402f--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-HOME-07 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-HOME-07--fbc3b--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-HOME-08 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-HOME-08--980b8--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-HOME-09 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-HOME-10 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-IAM-01 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-IAM-01-I-adfd3--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-IAM-02 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-IAM-02-I-5ae5d--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-IAM-03 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-IAM-03-I-e2d29--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-IAM-04 | P0 | web | KHÔNG ĐẠT | Error: expect(locator).toBeVisible() failed  Locator: locator('[data-screen-id="IAM-04"]').first() Expected: visible Timeout: 45000ms Error: element(s) not foun | 1/2 | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-IAM-04-I-8ba5c--không-tràn-control-có-nhãn-e2e/test-failed-1.png |
| TC-UI-IAM-05 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-IAM-05-I-5ff3c--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-IAM-06 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-IAM-06-I-7d86f--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-IAM-07 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-IAM-07-I-b21aa--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-IAM-08 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-IAM-08-I-d9e4f--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-IAM-09 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-ISS-01 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ISS-01-I-22600--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ISS-02 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ISS-02-I-a908d--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ISS-03 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ISS-03-I-b7056--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ISS-04 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ISS-04-I-bd7fa--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ISS-05 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ISS-05-I-3377b--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ISS-06 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ISS-06-I-4cbd5--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ISS-07 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ISS-07-I-d4cf3--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ISS-08 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-ISS-08-I-b1cbe--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-ISS-09 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-ISS-10 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MDM-01 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-01-M-23d5f--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-02 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-02-M-74ee1--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-03 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-03-M-a91fc--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-04 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-04-M-97100--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-05 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-05-M-3a25e--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-06 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-06-M-0921b--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-07 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-07-M-f9a39--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-08 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-08-M-8f70f--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-09 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-09-M-36d17--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-10 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-10-M-36f35--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-11 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-11-M-b2b7e--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-12 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-12-M-cb87d--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-13 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-13-M-8cce3--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-14 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-14-M-218c8--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-15 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-15-M-3a4e6--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-16 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-16-M-9c859--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-17 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-17-M-71a0f--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-18 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-18-M-ad8a6--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-19 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-19-M-947c7--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-20 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-20-M-917fb--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-21 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-21-M-8f46d--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-22 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-22-M-345c4--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-23 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-23-M-b844a--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-24 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-24-M-d25c1--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-25 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-25-M-c74f3--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-26 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-26-M-a29c6--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-27 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-27-M-f1d33--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-28 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-28-M-e4cd3--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-29 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-29-M-f2e1f--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-30 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-30-M-47ec4--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-31 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-31-M-6ce7a--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-32 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-32-M-5129d--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-33 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-MDM-33-M-912e0--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-MDM-34 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MDM-37 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MNE-01 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MNE-02 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MNE-03 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MNE-05 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MNE-06 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MNE-07 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MNE-09 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MOB-01 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-02 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-03 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-04 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-05 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-06 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-07 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-08 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-09 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-10 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-11 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-12 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-13 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-14 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-15 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-16 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-17 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-18 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-19 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-20 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-21 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-22 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-23 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-24 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-25 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-26 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-27 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-28 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-29 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-30 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-31 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-32 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-33 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-34 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-55 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-56 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-57 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-58 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-59 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-60 | P0 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-NOT-01 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-01-N-dc767--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-NOT-02 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-02-N-c7752--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-NOT-03 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-03-N-33d3f--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-NOT-04 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-04-N-16e81--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-NOT-05 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-05-N-08bcb--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-NOT-06 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-06-N-dfddf--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-NOT-07 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-07-N-eb7bc--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-NOT-08 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-08-N-fa3a8--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-NOT-09 | P0 | web | KHÔNG ĐẠT | Test timeout of 60000ms exceeded. | 1/2 | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-09-N-e5f56--không-tràn-control-có-nhãn-e2e/video.webm |
| TC-UI-NOT-10 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-10-N-18904--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-NOT-11 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-11-N-02b05--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-NOT-12 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-12-N-d51f6--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-NOT-13 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-13-N-b1fb8--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-NOT-14 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-14-N-57272--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-NOT-15 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-15-N-74e78--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-NOT-16 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-NOT-16-N-85303--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-NOT-17 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PRJ-01 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PRJ-01-P-a86c1--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PRJ-02 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PRJ-02-P-fa8b8--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PRJ-03 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PRJ-03-P-fc08a--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PRJ-04 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PRJ-04-P-b33ef--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PRJ-05 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PRJ-05-P-3bbf5--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PRJ-06 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PRJ-06-P-62e22--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PRJ-07 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PRJ-07-P-18cbf--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PRJ-08 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PRJ-08-P-ef4f7--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PRJ-09 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PRJ-09-P-ee330--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PRJ-10 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PRJ-10-P-b7f4b--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PRJ-11 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PRJ-11-P-79090--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PRJ-12 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PRJ-12-P-c0314--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PRJ-13 | P0 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PRJ-13-P-bc15b--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PRJ-14 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PRJ-15 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PRJ-17 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PRJ-18 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PRJ-19 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PRJ-20 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PRJ-21 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-11 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-12 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-13 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-14 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-SAS-22 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-SAS-25 | P0 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UX01 | P0 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC109 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC114 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC115 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC118 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC119 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC120 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC122 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC123 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC124 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC125 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC128 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC13 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC133 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC135 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC136 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC137 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC138 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC14 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC140 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC142 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC144 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC148 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC15 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC151 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC152 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC154 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC156 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC158 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC16 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC160 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC161 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC162 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC163 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC166 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC167 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC168 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC169 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC17 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC170 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC171 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC172 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC173 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC174 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC178 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC179 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC18 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC185 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC186 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC188 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC189 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC19 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC190 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC191 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC192 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC193 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC194 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC198 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC199 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC20 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC208 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC209 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC21 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC211 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC214 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC215 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC216 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC218 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC219 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC22 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC227 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC23 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC231 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC232 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC233 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC235 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC236 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC239 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC25 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC255 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC259 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC260 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC261 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC262 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC263 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC269 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC27 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC270 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC271 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC272 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC273 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC274 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC275 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC278 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC279 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC28 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC280 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC281 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC282 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC283 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC284 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC288 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC29 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC292 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC293 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC294 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC296 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC297 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC298 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC299 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC30 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC306 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC31 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC310 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC313 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC315 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC316 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC317 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC32 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC328 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC329 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC33 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC334 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC336 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC337 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC34 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC340 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC342 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC343 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC345 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC35 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC353 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC354 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC355 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC358 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC359 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC362 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC363 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC364 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC365 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC366 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC367 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC37 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC371 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC372 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC373 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC374 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC375 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC381 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC382 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC383 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC384 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC385 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC387 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC389 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC39 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC390 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC391 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC393 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC394 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC395 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC398 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC40 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC41 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC412 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC416 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC418 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC42 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC420 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC422 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC423 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC425 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC426 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC428 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC429 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC431 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC438 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC441 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC443 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC444 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC447 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC449 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC45 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC451 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC452 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC453 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC456 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC46 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC462 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC463 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC464 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC469 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC47 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC470 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC474 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC476 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC477 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC48 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC480 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC482 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC483 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC484 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC489 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC49 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC490 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC491 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC493 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC494 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC495 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC50 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC505 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC506 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC507 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC51 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC52 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC53 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC54 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-AC55 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC56 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC57 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC58 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC59 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC60 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC61 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC62 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC63 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC64 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC65 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC66 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-AC67 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-NFR-ACCESSIBILITY-02 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-AI-04 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-AVAILABILITY-01 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-AVAILABILITY-04 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-LEGAL-03 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-OBSERVABILITY-02 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-PERFORMANCE-01 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-PERFORMANCE-02 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-PERFORMANCE-03 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-PERFORMANCE-04 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-PRIVACY-03 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-RETENTION-01 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-RETENTION-02 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-NFR-RETENTION-03 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-11 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-18 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-22 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-25 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-26 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-28 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-30 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-32 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-34 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-35 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-37 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-38 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-40 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-45 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-47 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-48 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-49 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-50 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-51 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-52 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-53 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-55 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-56 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-57 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-58 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-60 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-62 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-65 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-66 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-67 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-68 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-69 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-71 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-72 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PLAN-74 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-04 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-11 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-14 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-A11-01 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-BND-05 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-BND-06 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-BND-07 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-BND-08 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-BND-10 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-BND-11 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-BND-14 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-BND-15 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-BRD-01 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-CON-04 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-EDN-01 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-GAN-01 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-NEG-01 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-NEG-03 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-NEG-05 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-NEG-07 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-NEG-09 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-PERF-01 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-RET-01 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-SEC-10 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-STA-02 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-STA-03 | P1 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-AST-01 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AST-02 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AST-03 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AST-04 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AST-05 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AST-06 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AST-07 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AUD-09 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-AUD-11 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-BI-01 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BI-01-BI-85247--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BI-02 | P1 | web | KHÔNG ĐẠT | Error: expect(received).toBeLessThanOrEqual(expected)  Expected: <= 1 Received:    6 | 2/2 | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BI-02-BI-b462d--không-tràn-control-có-nhãn-e2e/test-failed-1.png |
| TC-UI-BI-03 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BI-03-BI-336fd--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BI-04 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BI-04-BI-68b70--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BI-05 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BI-05-BI-5f9d5--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BI-06 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BI-06-BI-4ccf8--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BI-07 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BI-07-BI-1653f--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BI-08 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BI-08-BI-42bee--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BI-09 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BI-09-BI-c5abb--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BI-10 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BI-10-BI-849a7--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BI-11 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BI-11-BI-12b88--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BI-12 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BI-12-BI-d1418--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BI-13 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BI-13-BI-d8952--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BI-14 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BI-14-BI-d4439--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BI-15 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-BI-16 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-BI-17 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-BI-18 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-BID-01 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-01-B-2caaa--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-02 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-02-B-d6afb--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-03 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-03-B-21ac2--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-04 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-04-B-ca1ed--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-05 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-05-B-f1229--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-06 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-06-B-29158--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-07 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-07-B-95e36--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-08 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-08-B-6c6be--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-09 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-09-B-fde8e--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-10 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-10-B-6a745--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-11 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-11-B-73e7d--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-12 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-12-B-d5d4c--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-13 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-13-B-c325d--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-14 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-14-B-49bfe--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-15 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-15-B-a73bd--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-16 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-16-B-c86af--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-17 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-17-B-562cb--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-18 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-18-B-00e4d--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-19 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-19-B-90086--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-20 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-BID-20-B-00f2e--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-BID-21 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-CAP-18 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-CAP-21 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-CTR-01 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-01-C-2a4b8--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-02 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-02-C-fc3c3--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-03 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-03-C-03323--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-04 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-04-C-29a81--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-05 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-05-C-4ea7d--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-06 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-06-C-3fd2e--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-07 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-07-C-62e72--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-08 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-08-C-a16cf--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-09 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-09-C-72d41--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-10 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-10-C-480a1--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-11 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-11-C-61e70--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-12 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-12-C-88854--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-13 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-13-C-7e85d--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-14 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-14-C-af61a--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-15 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-15-C-90172--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-16 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-16-C-a066e--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-17 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-17-C-b5cbc--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-18 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-CTR-18-C-50ea4--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-CTR-19 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-CTR-20 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-CTR-21 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-CTR-22 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-CTR-23 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-CTR-24 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-CTR-25 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-CTR-26 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DGV-01 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-01-D-2c764--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-02 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-02-D-93bd6--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-03 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-03-D-d89a6--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-04 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-04-D-a3a0b--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-05 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-05-D-2eba8--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-06 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-06-D-4b28f--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-07 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-07-D-d0b4b--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-08 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-08-D-6e171--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-09 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-09-D-3b44f--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-10 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-10-D-5c58c--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-11 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-11-D-4bd0a--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-12 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-12-D-f56e9--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-13 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-13-D-7b274--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-14 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-14-D-0945c--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-15 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-15-D-0c00f--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-16 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-16-D-ad2ba--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-17 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-17-D-4ef10--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-18 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-DGV-18-D-7722d--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-DGV-19 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DGV-20 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DGV-21 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DIS-23 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-15 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-16 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-17 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-18 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-20 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-DOC-22 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-DOC-23 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-ISS-11 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LLM-01 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-01-L-cccba--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-02 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-02-L-79ade--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-03 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-03-L-f3d94--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-04 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-04-L-7aae2--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-05 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-05-L-2b4c9--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-06 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-06-L-6e257--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-07 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-07-L-c074b--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-08 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-08-L-0d67c--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-09 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-09-L-cd12b--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-10 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-10-L-f526d--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-11 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-11-L-6d5c2--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-12 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-12-L-e2dd4--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-13 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-13-L-56c35--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-14 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-14-L-4e893--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-15 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-15-L-9dfc7--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-16 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-16-L-e0939--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-17 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-17-L-cccc3--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-18 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-LLM-18-L-baa3a--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-LLM-19 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LLM-20 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LLM-21 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LND-01 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LND-02 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LND-03 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LND-04 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LND-05 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LND-06 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LND-07 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LND-08 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LND-09 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LND-10 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LND-11 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LND-12 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-LND-13 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MDM-35 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MDM-36 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MNE-04 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MNE-08 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MNE-10 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-MOB-35 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-36 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-37 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-38 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-39 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-40 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-41 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-42 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-43 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-44 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-45 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-46 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-47 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-48 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-49 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-50 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-51 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-52 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-53 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-54 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-61 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-62 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-63 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-64 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-65 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-66 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-67 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-MOB-68 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-OMNI-01 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-OMNI-01--ff6cc--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-OMNI-02 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-OMNI-02--1c39b--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-OMNI-03 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-OMNI-03--10418--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-OMNI-04 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-OMNI-04--15a7b--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-OMNI-05 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-OMNI-05--3b35d--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-OMNI-06 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-OMNI-06--660b7--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-OMNI-07 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-OMNI-07--d5003--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-OMNI-08 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-OMNI-08--4c189--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-OMNI-09 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-OMNI-09--a54d6--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-OMNI-10 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-OMNI-10--bf7c5--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-OMNI-11 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PAY-01 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PAY-01-P-414a5--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PAY-02 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PAY-02-P-b2fec--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PAY-03 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PAY-03-P-50610--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PAY-04 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PAY-04-P-32e25--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PAY-05 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PAY-05-P-aee48--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PAY-06 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PAY-06-P-0ee63--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PAY-07 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PAY-07-P-20c27--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PAY-08 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PAY-08-P-04b12--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PAY-09 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-PAY-09-P-f19a0--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-PAY-10 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PAY-11 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PAY-12 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PAY-13 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PAY-14 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PAY-15 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PAY-16 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PAY-17 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PMT-01 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PMT-02 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PMT-03 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PMT-04 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PMT-05 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PMT-06 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PRJ-16 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-01 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-02 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-03 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-04 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-05 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-06 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-07 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-08 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-09 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-10 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-15 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-PWF-16 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-QMS-01 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-QMS-02 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-QMS-03 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-QMS-04 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-QMS-05 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-QMS-06 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-QMS-07 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-QMS-08 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-QMS-09 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-QMS-10 | P1 | android | KHÔNG CHẠY | lop-loi |  |  |
| TC-UI-QMS-11 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-SAS-01 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-01-S-89bf1--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-02 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-02-S-7e304--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-03 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-03-S-51ddc--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-04 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-04-S-2a036--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-05 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-05-S-24245--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-06 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-06-S-735eb--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-07 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-07-S-e854a--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-08 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-08-S-d50b3--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-09 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-09-S-0dfad--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-10 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-10-S-6b3c4--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-11 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-11-S-d6cad--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-12 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-12-S-ae7d7--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-13 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-13-S-d9018--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-14 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-14-S-72b38--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-15 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-15-S-4178b--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-16 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-16-S-03aad--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-17 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-17-S-fafa5--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-18 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-18-S-47502--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-19 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-19-S-f758a--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-20 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-20-S-37f3c--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-21 | P1 | web | KHÔNG CHẠY | ca báo ĐẠT nhưng thiếu hiện vật đã khai `screenshot-final` — không truy ngược được |  | uat/run/uat-2026-11-16-production-demo/artifacts/screens.e2e-TC-UI-SAS-21-S-d4184--không-tràn-control-có-nhãn-e2e/test-finished-1.png |
| TC-UI-SAS-23 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UI-SAS-24 | P1 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-BND-09 | P2 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-BND-12 | P2 | api | KHÔNG CHẠY | lop-loi |  |  |
| TC-UAT-PWF-UX-01 | P2 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |
| TC-UAT-PWF-WRK-01 | P2 | web | KHÔNG CHẠY | khong-co-kich-ban |  |  |

## Monkey test

- `web-20261116.json`: seed 20261116 · 125 thao tác · bất thường 0 · tái hiện: `node <skill>/scripts/monkey_web.mjs --url https://180-93-34-176.sslip.io:8443 --seed 20261116 --actions <bước>`
- `web-20261117.json`: seed 20261117 · 121 thao tác · bất thường 4 · tái hiện: `node <skill>/scripts/monkey_web.mjs --url https://180-93-34-176.sslip.io:8443/home/home-02 --seed 20261117 --actions <bước>`
  - S3 **console.error** bước 49 ×2: Failed to load resource: the server responded with a status of 403 () — ảnh `monkey\shots\s20261117-b49-console.error.png`
  - S3 **console.error** bước 53 ×2: Failed to load resource: the server responded with a status of 403 () — ảnh `monkey\shots\s20261117-b53-console.error.png`
  - S3 **console.error** bước 53 ×7: Failed to load resource: the server responded with a status of 403 () — ảnh `monkey\shots\s20261117-b53-console.error.png`
  - S3 **console.error** bước 64 ×1: Failed to load resource: the server responded with a status of 403 () — ảnh `monkey\shots\s20261117-b64-console.error.png`

---

Kỹ năng này **không** đề xuất cách sửa và **không** sửa gì. Phát hiện được bàn giao cho
người hoặc cho stage `fix` của harness; người có thẩm quyền quyết định ký duyệt (G7).
