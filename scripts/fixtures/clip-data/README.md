# Bộ dữ liệu của lớp nạp (`scripts/clip-seed.mjs`)

| Tệp | Là gì |
|---|---|
| `camau.json` | **Bộ dữ liệu demo mặc định của bản công** "Hệ thống quản lý đầu tư công": tỉnh Cà Mau sau hợp nhất năm 2025. Tenant "UBND tỉnh Cà Mau", 28 đơn vị, 30 địa bàn (xã, phường), 45 dự án (32 dự án đặt tên trong `projectCatalogue` cộng 13 dự án của các nhóm nền), 10 tài khoản. |
| `demo-roles.json` | Quyền của năm vai đơn vị của bộ demo (bản chụp `docsRoles` của stack docs), dùng khi tạo vai trên một bản cài. |
| `public.json` | Bộ cũ của clip bản công (tỉnh Cao Bằng). Còn dùng cho clip và test; không còn là dữ liệu demo mặc định. |
| `enterprise.json` | Bộ của bản doanh nghiệp. |

**`camau.json` là dữ liệu MINH HỌA.** Tên đơn vị hành chính và tên cơ quan tra theo nguồn công khai (liệt kê ở `docs/runbooks/demo-data-camau.md`, mục 7).
Tên dự án, mã dự án, tổng mức đầu tư, kế hoạch vốn, số giải ngân, gói thầu, nhà thầu, hợp đồng, văn bản, số hiệu quyết định và tên người đều được dựng để trình diễn:
**không phải số liệu thật của tỉnh Cà Mau**, không phải danh mục dự án thật, và không chỉ một người thật nào. Không tệp nào ở đây chứa mật khẩu, khóa hay token.

Các phần riêng của `camau.json`:

- `projectCatalogue`: từng dự án với mã, tên, địa bàn, ngành, loại, tổng mức (tỷ đồng) và giai đoạn; nhóm A, B, C suy ra từ tổng mức.
- `tenant`: mã và tên tenant, tỉnh trong danh mục nền (`CA-MAU`), cây đơn vị (`key` là tên mà các nhóm seed dùng để hỏi đơn vị), tên vai, tài khoản (`demo` là chủ sở hữu tenant).
- `localize.pairs`: các cặp `[từ của bộ hướng dẫn, từ của Cà Mau]`; `node scripts/clip-seed.mjs plan --dataset camau` báo lỗi khi một chuỗi của bộ dữ liệu không đi qua được nguyên vẹn.

Cách nạp, xóa, nạp lại: `docs/runbooks/demo-data-camau.md`. Mô tả lớp nạp: `docs/clip-data.md`.
