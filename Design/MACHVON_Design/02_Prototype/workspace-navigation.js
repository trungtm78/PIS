/* Business navigation: workspace > module > task group > contextual screen. */
const workspaceAreas=[
 {id:'overview',name:'Điều hành',icon:'overview',modules:['HOME','IAM','DOC']},
 {id:'investment',name:'Đầu tư',icon:'investment',modules:['PRJ','CAP','DIS','PAY','CTR','ISS','LND','PMT','QMS','AST']},
 {id:'insights',name:'Phân tích',icon:'insights',modules:['BID','BI','MNE','AUD']},
 {id:'engagement',name:'Tương tác',icon:'engagement',modules:['NOT','OMNI']},
 {id:'data',name:'Dữ liệu',icon:'data',modules:['MDM','DGV']},
 {id:'admin',name:'Quản trị',icon:'admin',modules:['ADM','LLM','SAS']}
];
const taskGroup=(title,description,ids,primary=ids,parents={})=>({title,description,ids,primary,parents});
const workspaceModules={
 HOME:{name:'Điều hành',groups:[taskGroup('Bức tranh tổng thể','Tổng quan, nguồn vốn và bản đồ',[1,5,7,8],[1,5,7],{8:7}),taskGroup('Công việc & cảnh báo','Ưu tiên, cảnh báo và hiệu quả',[2,3,4,6],[2,3,4],{6:3})]},
 IAM:{name:'Tài khoản & hỗ trợ',groups:[taskGroup('Không gian cá nhân','Tổ chức, hồ sơ và thiết bị',[4,5,6],[4,5,6]),taskGroup('Tra cứu & hỗ trợ','Tìm kiếm và yêu cầu trợ giúp',[7,8]),taskGroup('Truy cập','Đăng nhập và khôi phục tài khoản',[1,2,3],[1],{2:1,3:1})]},
 PRJ:{name:'Quản lý dự án',groups:[taskGroup('Danh mục & theo dõi','Dự án, tiến độ và đội ngũ',[1,2,3,7,8,13],[1,7,13],{2:1,3:1,8:7}),taskGroup('Chuẩn bị đầu tư','Chủ trương, pháp lý và thẩm định',[4,9,10],[9,4,10]),taskGroup('Thực hiện & kết thúc','Cấu phần, điều chỉnh và bàn giao',[5,6,11,12],[5,6,11,12])]},
 CAP:{name:'Kế hoạch & nguồn vốn',groups:[taskGroup('Kế hoạch vốn','Trung hạn, năm và theo dõi',[1,2,3,10,15],[1,3,15,10],{2:1}),taskGroup('Nguồn & phân bổ','Nguồn vốn, giao vốn và điều chuyển',[4,5,6,7,9,14],[4,5,6,7,9,14]),taskGroup('Điều hành theo kỳ','Đăng ký, ước giải ngân và khóa năm',[8,11,12,13],[8,12,11],{13:12})]},
 DIS:{name:'Báo cáo giải ngân',groups:[taskGroup('Lập & gửi báo cáo','Danh sách, nhập liệu và rà soát',[1,2,3,4,5,6,7,8,9,10,18],[1,10],{2:1,3:1,4:1,5:1,6:1,7:1,8:1,9:1,18:1}),taskGroup('Tổng hợp & phân tích','Chủ đầu tư, thuyết minh và số liệu',[11,12,13,16,17],[12,13,16,11],{17:16}),taskGroup('Quản lý kỳ báo cáo','Lịch kỳ và tiến độ nộp',[14,15])]},
 PAY:{name:'Thanh toán & Kho bạc',groups:[taskGroup('Hồ sơ thanh toán','Đề nghị, chứng từ và theo dõi gửi',[1,2,3,4],[1,4],{2:1,3:1}),taskGroup('Đối soát & kiểm soát','Giao dịch, tạm ứng và sai lệch',[5,6,7,8],[5,7],{6:5,8:5}),taskGroup('Theo dõi liên thông','Dự án và dữ liệu Kho bạc',[9])]},
 CTR:{name:'Hợp đồng & thực hiện',groups:[taskGroup('Hợp đồng & điều khoản','Ký kết, BOQ, bảo lãnh và tạm ứng',[1,2,3,4,5,6],[1,4,5,6],{2:1,3:1}),taskGroup('Thực hiện & thay đổi','Hiện trường, chất lượng và phát sinh',[7,8,9,10,11,14],[9,7,11,14],{8:7,10:9}),taskGroup('Nghiệm thu & kết thúc','Thanh toán, bàn giao và bảo hành',[12,13,15,16,17,18],[12,13,15,16,17,18])]},
 ISS:{name:'Vướng mắc & hiện trường',groups:[taskGroup('Tiếp nhận & xử lý','Vướng mắc, chuyển cấp và hoàn tất',[1,2,3,4,7],[1],{2:1,3:1,4:1,7:1}),taskGroup('Giám sát hiện trường','Kiểm tra, tiến độ và ma trận tuần',[5,6,8])]},
 BID:{name:'Nhà thầu & phân tích AI',groups:[taskGroup('Nhà thầu & lựa chọn','Hồ sơ, kế hoạch và mốc lựa chọn',[1,2,3,15,16,17,18,19,20],[1,3,15,17,18,19,20],{2:1,16:15}),taskGroup('Chuẩn bị phân tích','Tiêu chí, tiếp nhận và kiểm tra OCR',[4,5,6,7,8],[4,5,7,8],{6:5}),taskGroup('Thẩm tra & kết quả','Dẫn chứng, so sánh và đánh giá',[9,10,11,12,13,14],[9,10,12,13,14],{11:9})]},
 BI:{name:'BI & dashboard',groups:[taskGroup('Khám phá & thiết kế','Dashboard, biểu đồ và phân tích',[1,2,3,4,9,10],[1,2,3,9],{4:3,10:3}),taskGroup('Chỉ tiêu & dữ liệu','Ngữ nghĩa, nguồn và phân quyền',[5,6,7,8,14],[5,7,8,14],{6:5}),taskGroup('Công bố & vận hành','Phê duyệt, lịch xuất và hiệu năng',[11,12,13])]},
 NOT:{name:'Trung tâm thông báo',groups:[taskGroup('Của tôi','Hộp thông báo và cách nhận tin',[1,2,3],[1,3],{2:1}),taskGroup('Thiết kế & điều phối','Luồng, mẫu tin và chiến dịch',[6,7,8,9,10,16],[6,7,9,10,16],{8:7}),taskGroup('Theo dõi vận hành','Tổng quan, hàng đợi và xử lý lỗi',[4,11,12,13],[4,11,13],{12:11}),taskGroup('Kênh & kiểm soát','Sự kiện, thiết bị và chi phí',[5,14,15])]},
 OMNI:{name:'Tương tác đa kênh',groups:[taskGroup('Hội thoại & liên hệ','Hộp thư, danh bạ và đồng ý nhận tin',[1,2,3,4,9],[1,3,4],{2:1,9:1}),taskGroup('Kênh & vận hành','Kết nối, SLA và mẫu trả lời',[5,6,7,8,10],[5,7,8,10],{6:5})]},
 LLM:{name:'Quản trị AI & LLM',groups:[taskGroup('Điều hành AI','Tổng quan, trace và sự cố',[1,14,18],[1,14,18]),taskGroup('Model & định tuyến','Nhà cung cấp, model và profile',[2,3,4,5,6]),taskGroup('Chi phí & sử dụng','Ngân sách, giá và đối soát',[7,8,9]),taskGroup('Chất lượng & phát hành','Prompt, đánh giá và guardrail',[10,11,12,13,15,16,17])]},
 ADM:{name:'Quản trị tổ chức',groups:[taskGroup('Tổ chức & con người','Đơn vị, thành viên, quyền và ủy quyền',[1,2,3,4]),taskGroup('Quy trình & cấu hình','Danh mục, quy trình, lịch và chữ ký',[5,6,7,8]),taskGroup('Tích hợp & an toàn','Đồng bộ, chuyển đổi và kiểm toán',[9,10,11,12,13,14])]},
 SAS:{name:'Nền tảng SaaS',groups:[taskGroup('Tenant & thương hiệu','Khởi tạo, tên miền và nhận diện',[1,2,3,4,5],[1,4,5],{2:1,3:1}),taskGroup('Thương mại & thuê bao','Gói, kỳ hạn, hóa đơn và sử dụng',[6,7,8,9,10,11],[6,9,10,11],{7:9,8:9}),taskGroup('License & quyền sử dụng','Cấp, gia hạn, thu hồi và lịch sử',[12,13,14,15,16],[12,14,16],{13:12,15:12}),taskGroup('Vận hành nền tảng','Sức khỏe, hỗ trợ, sao lưu và exit',[17,18,19,20,21],[18,19,20,21,17])]},
 MDM:{name:'Danh mục dùng chung',groups:[taskGroup('Tổ chức & đầu tư','Địa bàn, đơn vị, nguồn vốn và dự án',[1,2,3,4,5,6,7,8,9],[1,2,3,4,5,6,7,8,9]),taskGroup('Nghiệp vụ & quy ước','Văn bản, kỳ, hợp đồng và Kho bạc',[10,11,12,13,14,15,16,17,18,19,20]),taskGroup('Liên thông & chính sách','Sự kiện, ngôn ngữ, mã và phạm vi',[21,22,23,24,33]),taskGroup('Vòng đời danh mục','Hiệu lực, chất lượng và công bố',[25,26,27,28,29,30,31,32],[29,30,32,28],{25:29,26:28,27:28,31:32})]},
 DGV:{name:'Quản trị dữ liệu',groups:[taskGroup('Nền tảng dữ liệu','Danh mục, thuật ngữ, owner và lineage',[1,2,3,4,5],[1,4,2,3,5]),taskGroup('Chất lượng & kiểm soát','Quy tắc, profiling, sự cố và đối soát',[6,7,8,9,10,12],[7,6,8,9,10,12]),taskGroup('Liên thông & bảo vệ','Contract, pipeline, lưu trữ và quyền',[11,13,14,15]),taskGroup('Trưởng thành & giá trị','Đánh giá, lộ trình và data product',[16,17,18])]}
};
const workspaceSymbols={overview:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',investment:'<path d="M3 21h18M5 21V9l7-5 7 5v12M9 21v-7h6v7M9 10h6"/>',insights:'<path d="M4 19V5m0 14h16M8 15l4-5 4 2 5-7"/>',engagement:'<path d="M20 12a8 8 0 0 1-8 8H4l1.7-4A8 8 0 1 1 20 12Z"/><path d="M8 10h8m-8 4h5"/>',data:'<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v7c0 4 16 4 16 0V5M4 12v7c0 4 16 4 16 0v-7"/>',admin:'<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z"/><path d="m8 12 3 3 5-6"/>',chevron:'<path d="m9 5 7 7-7 7"/>',grid:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',search:'<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>'};
const workspaceIcon=name=>`<svg viewBox="0 0 24 24" fill="none" aria-hidden="true">${workspaceSymbols[name]||workspaceSymbols.grid}</svg>`;
const workspaceId=(module,n)=>module+'-'+String(n).padStart(2,'0');
const workspaceScreen=(module,n)=>SCREENS.find(s=>s.id===workspaceId(module,n));

Object.assign(workspaceSymbols,{
 home:'<path d="m3 11 9-8 9 8M5 10v11h5v-7h4v7h5V10"/>',
 inbox:'<path d="M4 4h16l2 13v3H2v-3L4 4Z"/><path d="M2 15h6l2 3h4l2-3h6"/>',
 task:'<rect x="4" y="3" width="16" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
 wallet:'<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M16 11h5v5h-5a2.5 2.5 0 0 1 0-5ZM5 5V3h13"/>',
 agreement:'<path d="M6 2h9l4 4v8M6 2v20h6M9 8h5M9 12h4"/><circle cx="17" cy="18" r="3"/><path d="m15.5 20.5-.5 2 2-1 2 1-.5-2"/>',
 contract:'<path d="M6 2h9l4 4v16H6V2Z M14 2v5h5M9 11h7m-7 4h7m-7 4h4"/>',
 pin:'<path d="m8 3 8 0-1 6 4 4v2H5v-2l4-4-1-6ZM12 15v7"/>',
 star:'<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
 plus:'<path d="M12 5v14M5 12h14"/>',
 help:'<circle cx="12" cy="12" r="9"/><path d="M9 9a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01"/>'
});
const quickModules=[['PRJ','Dự án','investment'],['CAP','Kế hoạch vốn','wallet'],['DIS','Giải ngân','insights'],['CTR','Hợp đồng','agreement'],['PAY','Thanh toán','contract'],['BID','Nhà thầu','task'],['BI','BI & báo cáo','overview']];
const contextualShortcuts={
 NOT:[[6,'Điều phối thông báo'],[4,'Vận hành gửi tin'],[3,'Tùy chọn nhận tin']],
 PRJ:[[7,'Tiến độ & mốc'],[4,'Hồ sơ pháp lý'],[9,'Chủ trương đầu tư'],[12,'Quyết toán']],
 CAP:[[3,'Kế hoạch năm'],[6,'Phân bổ vốn'],[7,'Điều chỉnh vốn'],[15,'Theo dõi kế hoạch']],
 DIS:[[12,'Tổng hợp giải ngân'],[13,'Thuyết minh tháng'],[15,'Tiến độ nộp'],[14,'Lịch kỳ báo cáo']],
 PAY:[[4,'Theo dõi Kho bạc'],[5,'Đối soát giao dịch'],[7,'Tạm ứng & thu hồi']],
 BID:[[3,'Gói thầu & đề án'],[9,'Phân tích AI'],[10,'So sánh đề án'],[15,'Kế hoạch lựa chọn']],
 BI:[[2,'Dashboard của tôi'],[3,'Thiết kế dashboard'],[5,'Chỉ tiêu'],[9,'Phân tích dữ liệu']],
 MDM:[[2,'Địa bàn'],[3,'Cơ quan & chủ đầu tư'],[4,'Nguồn vốn'],[32,'Duyệt & công bố']],
 DGV:[[7,'Chất lượng dữ liệu'],[8,'Sự cố dữ liệu'],[16,'Trưởng thành dữ liệu']],
 LLM:[[3,'Kho model'],[4,'Model theo tác vụ'],[7,'Ngân sách & quota'],[9,'Usage & đối soát']],
 SAS:[[4,'Thương hiệu'],[9,'Thuê bao'],[12,'Cấp license'],[18,'Sức khỏe nền tảng']],
 ADM:[[2,'Thành viên'],[3,'Vai trò & quyền'],[6,'Quy trình'],[11,'Nhật ký kiểm toán']],
 CTR:[[4,'BOQ & mốc thanh toán'],[9,'Nhật ký công trường'],[12,'Nghiệm thu'],[17,'Quyết toán']],
 OMNI:[[3,'Danh bạ'],[5,'Kết nối kênh'],[8,'Mẫu trả lời'],[10,'Thống kê']],
 ISS:[[5,'Kiểm tra hiện trường'],[6,'Tiến độ xử lý'],[8,'Ma trận vướng mắc']]
};
const moduleDescriptions={HOME:'Theo dõi danh mục đầu tư, tiến độ và việc cần quyết định.',IAM:'Tài khoản, truy cập và hỗ trợ sử dụng.',PRJ:'Hồ sơ, tiến độ và các mốc trong vòng đời dự án.',CAP:'Kế hoạch trung hạn, phân bổ và điều hành nguồn vốn.',DIS:'Lập, rà soát và theo dõi báo cáo giải ngân.',PAY:'Hồ sơ thanh toán, tạm ứng và đối soát Kho bạc.',BID:'Nhà thầu, lựa chọn và thẩm tra đề án có AI hỗ trợ.',BI:'Khám phá dữ liệu và thiết kế báo cáo theo nhu cầu.',NOT:'Các cập nhật liên quan đến công việc và hồ sơ bạn theo dõi.',OMNI:'Hội thoại, liên hệ và tương tác đa kênh.',LLM:'Model, chất lượng, ngân sách và hoạt động AI.',ADM:'Tổ chức, thành viên, quyền và quy trình.',SAS:'Tenant, thương hiệu, thuê bao và license.',MDM:'Dữ liệu nền thống nhất cho toàn bộ nghiệp vụ.',DGV:'Chất lượng, trách nhiệm và trưởng thành dữ liệu.',CTR:'Hợp đồng, khối lượng, nghiệm thu và bàn giao.',ISS:'Tiếp nhận vướng mắc và điều phối xử lý hiện trường.'};
/* Data-driven completion (screen_catalog -> SCREENS): every web screen is reachable from the single sidebar,
   whether its task group is hand-written, listed in workspaceExtensions, seeded, or generated from the screen kind. */
Object.assign(moduleDescriptions,{DOC:'Văn bản hành chính, số ký hiệu, ký số và báo cáo theo chuẩn nhà nước.',LND:'Giải phóng mặt bằng, bồi thường, hỗ trợ và tái định cư.',PMT:'Hồ sơ pháp lý, giấy phép và mốc hiệu lực của dự án.',QMS:'Chất lượng công trình, nhật ký thi công và nghiệm thu.',AUD:'Thanh tra, kiểm toán, kiến nghị và theo dõi khắc phục.',AST:'Tài sản hình thành từ đầu tư, bàn giao và hạch toán.',MNE:'Báo cáo giám sát, đánh giá đầu tư và nộp Hệ thống quốc gia.'});
Object.assign(contextualShortcuts,{MNE:[[1,'Lịch nghĩa vụ báo cáo'],[3,'Báo cáo tổng thể'],[5,'Rà soát & phát hành'],[9,'Tiến độ nộp']],
 DOC:[[3,'Văn bản đi'],[4,'Rà soát và trình ký'],[12,'Văn bản đến'],[10,'Sổ đăng ký']],
 QMS:[[2,'Lập nhật ký ngày'],[4,'Đề nghị nghiệm thu'],[7,'Không phù hợp'],[11,'Độ phủ nhật ký']],
 LND:[[3,'Hộ bị ảnh hưởng'],[5,'Phương án bồi thường'],[7,'Chi trả'],[10,'Bàn giao mặt bằng']],
 PMT:[[1,'Hồ sơ pháp lý'],[5,'Cảnh báo hết hạn'],[4,'Quy tắc cổng chặn']],
 AST:[[1,'Danh sách bàn giao'],[3,'Hồ sơ tài sản'],[4,'Bảo hành và giữ lại']],
 AUD:[[2,'Cuộc thanh tra'],[6,'Kiến nghị'],[7,'Theo dõi khắc phục'],[10,'Báo cáo kết quả']]
});
/* Hand-written groups for modules that have no entry in workspaceModules (name comes from the catalog). */
const workspaceSeeds={MNE:[taskGroup('Lịch & biểu mẫu','Nghĩa vụ báo cáo và mẫu biểu giám sát',[1,2],[1,2]),taskGroup('Lập & phát hành','Báo cáo tổng thể, dự án, nhanh tuần và đánh giá',[3,4,7,8,5,6],[3,4,7,8,5],{6:5}),taskGroup('Theo dõi & lịch sử','Tiến độ nộp, phiên bản và đính chính',[9,10],[9],{10:3})],
 QMS:[taskGroup('Nhật ký thi công','Lập, ký và đối soát độ phủ nhật ký',[1,2,3,11],[1,2,11],{3:2}),taskGroup('Chất lượng & nghiệm thu','Kiểm tra, thí nghiệm, không phù hợp và hiện trường',[4,5,6,7,8],[4,5,6,7,8])],
 PMT:[taskGroup('Hồ sơ & cảnh báo','Giấy phép của dự án và hạn hiệu lực',[1,2,5],[1,5],{2:1}),taskGroup('Danh mục & quy tắc','Loại giấy phép, cổng chặn và miễn trừ',[3,4,6],[3,4,6])],
 LND:[taskGroup('Tổng quan & thửa đất','Tình hình GPMB, thửa đất và hộ bị ảnh hưởng',[1,2,3],[1,2,3]),taskGroup('Kiểm đếm & phương án','Kiểm đếm, phương án, niêm yết và chi trả',[4,5,6,7],[4,5,7],{6:5}),taskGroup('Xử lý & bàn giao','Khiếu nại, cưỡng chế và bàn giao mặt bằng',[8,9,10,11],[8,9,10,11]),taskGroup('Tái định cư & dữ liệu cá nhân','Tái định cư và yêu cầu của chủ thể dữ liệu',[12,13],[12],{13:3})],
 AST:[taskGroup('Bàn giao tài sản','Danh sách, biên bản và hồ sơ tài sản',[1,2,3],[1,3],{2:1}),taskGroup('Bảo hành & vận hành','Giữ lại, yêu cầu bảo hành và bảo trì',[4,5,6,7],[4,5,6],{7:3})],
 DOC:[taskGroup('Tổng quan & soạn thảo','Tình hình văn bản, soạn thảo và danh sách đi',[1,2,3],[1,2,3]),taskGroup('Trình ký & phát hành','Rà soát, ký số, cấp số và phân phối',[4,5,6,7,8,9,10],[4,5,6,8,10],{7:5,9:8}),taskGroup('Văn bản đến','Tiếp nhận, phân công và xử lý',[11,12,13],[11,12],{13:12}),taskGroup('Mẫu, thể thức & lưu trữ','Mẫu, thể thức, hồ sơ lưu và liên thông',[14,15,16,17,18,19,20,21],[14,16,17,20,21],{15:14,18:17,19:10})],
 AUD:[taskGroup('Cuộc thanh tra, kiểm toán','Danh sách, hồ sơ và tiếp nhận kết luận',[1,2,3,4],[1,2,4],{3:2}),taskGroup('Phát hiện & kiến nghị','Phát hiện, kiến nghị và theo dõi thực hiện',[5,6,7,11],[5,6,7,11]),taskGroup('Khắc phục & báo cáo','Thu hồi, bằng chứng và báo cáo kết quả',[8,9,10],[8,9,10])]};
const workspaceModuleNames={DOC:'Văn bản & báo cáo',LND:'GPMB & tái định cư',QMS:'Chất lượng & nhật ký thi công',AST:'Bàn giao tài sản & bảo hành',AUD:'Thanh tra & kiểm toán'};
/* [group title, ids, primary ids, parents, description] appended to hand-written groups of existing modules. */
const workspaceExtensions={
 IAM:[['Không gian cá nhân',[9],[9]]],
 HOME:[['Bức tranh tổng thể',[9,10],[9],{10:9}]],
 PRJ:[['Danh mục & theo dõi',[14,16,17,18,21],[14,16]],['Chuẩn bị đầu tư',[15],[15]],['Thực hiện & kết thúc',[19,20],[19,20]]],
 CAP:[['Kế hoạch vốn',[21],[21]],['Nguồn & phân bổ',[16,17,18,19],[16,17,19]],['Điều hành theo kỳ',[20],[20]]],
 DIS:[['Tổng hợp & phân tích',[19,23,24],[19,23,24]],['Quản lý kỳ báo cáo',[20,21,22,25],[20,21,25],{22:21}]],
 MDM:[['Tổ chức & đầu tư',[37],[37]],['Vòng đời danh mục',[34,35,36],[34,35,36]]],
 ADM:[['Tổ chức & con người',[15,16,17],[15,16,17]],['Quy trình & cấu hình',[18],[18]]],
 SAS:[['Tenant & thương hiệu',[22],[],{22:1}],['Thương mại & thuê bao',[24],[],{24:9}],['License & quyền sử dụng',[25],[25]],['Vận hành nền tảng',[23],[23]]],
 NOT:[['Của tôi',[17],[17]]],
 OMNI:[['Hội thoại & liên hệ',[11],[11]]],
 PAY:[['Hồ sơ thanh toán',[11],[11]],['Đối soát & kiểm soát',[10,12],[10,12],{12:7}],['Theo dõi liên thông',[13,14,17],[13,14,17]],['Quyết toán',[15,16],[15],{16:15},'Quyết toán niên độ và dự án hoàn thành']],
 CTR:[['Hợp đồng & điều khoản',[20,21,25,26],[20,21],{25:2,26:2}],['Thực hiện & thay đổi',[19,22],[19,22]],['Nghiệm thu & kết thúc',[23,24],[23,24]]],
 ISS:[['Tiếp nhận & xử lý',[9,10],[9,10]],['Giám sát hiện trường',[11],[11]]],
 BID:[['Nhà thầu & lựa chọn',[21],[21]]],
 BI:[['Chỉ tiêu & dữ liệu',[15,18],[15,18]],['Công bố & vận hành',[16,17],[16,17]]],
 LLM:[['Model & định tuyến',[19,21],[19,21]],['Chất lượng & phát hành',[20],[20]]],
 DGV:[['Liên thông & bảo vệ',[19,20],[19,20]],['Trưởng thành & giá trị',[21],[21]]]
};
const workspaceNavigationReport={generatedModules:[],seededModules:[],extended:[],autoAssigned:[],dropped:[],droppedModules:[],extraAreaModules:[]};
const workspaceKindBuckets=[['Tổng quan & theo dõi','Bảng điều khiển, danh sách, lịch và bản đồ',['dashboard','list','table','search','rank','map','calendar','kanban','board','chart','cards','segments']],['Lập & xử lý','Biểu mẫu, nhập liệu và hồ sơ',['form','funding','import','documents','confirm','editor','builder','keys','license','auth','brand','conversation']],['Kiểm soát & phê duyệt','Rà soát, phê duyệt, đối chiếu và quy tắc',['approval','review','criteria','reconcile','compare','policy','workflow','tree','timeline','detail','ai','scenario','allocation','cost']]];
function completeWorkspaceNavigation(){
 const web=SCREENS.filter(s=>s.platform==='web'),byModule=new Map(),number=s=>Number(s.id.split('-')[1]),side=new Set(['detail','confirm','success','error','empty','offline']);
 web.forEach(s=>{if(!byModule.has(s.module))byModule.set(s.module,[]);byModule.get(s.module).push(s)});
 byModule.forEach(list=>list.sort((a,b)=>number(a)-number(b)));
 for(const [code,list] of byModule){
  const have=new Set(list.map(number));
  if(!workspaceModules[code]){
   let groups=workspaceSeeds[code];
   if(groups)workspaceNavigationReport.seededModules.push(code);
   else{groups=workspaceKindBuckets.map(([title,description,kinds],i)=>{const items=list.filter(s=>kinds.includes(s.kind)||(i===workspaceKindBuckets.length-1&&!workspaceKindBuckets.some(b=>b[2].includes(s.kind))));return taskGroup(title,description,items.map(number),items.filter(s=>!side.has(s.kind)).map(number))}).filter(g=>g.ids.length);workspaceNavigationReport.generatedModules.push(code)}
   workspaceModules[code]={name:workspaceModuleNames[code]||list[0].moduleName,groups};
  }
  const module=workspaceModules[code];
  (workspaceExtensions[code]||[]).forEach(([title,ids,primary=ids,parents={},description])=>{let g=module.groups.find(x=>x.title===title);if(!g&&description){g=taskGroup(title,description,[],[],{});module.groups.push(g)}if(!g)return;ids.forEach(n=>{if(!g.ids.includes(n)){g.ids.push(n);workspaceNavigationReport.extended.push(workspaceId(code,n))}});primary.forEach(n=>{if(!g.primary.includes(n))g.primary.push(n)});Object.assign(g.parents,parents)});
  module.groups.forEach(g=>{
   g.ids.filter(n=>!have.has(n)).forEach(n=>workspaceNavigationReport.dropped.push(workspaceId(code,n)));
   g.ids=g.ids.filter(n=>have.has(n));g.primary=g.primary.filter(n=>g.ids.includes(n));
   Object.keys(g.parents).forEach(n=>{if(!g.ids.includes(Number(n))||!have.has(g.parents[n]))delete g.parents[n]});
  });
  const placed=new Set(module.groups.flatMap(g=>g.ids));
  [...have].filter(n=>!placed.has(n)).sort((a,b)=>a-b).forEach(n=>{
   // Fallback by screen-number range: join the group of the nearest lower (else higher) screen already placed.
   const lower=[...placed].filter(x=>x<n).sort((a,b)=>b-a)[0],higher=[...placed].filter(x=>x>n).sort((a,b)=>a-b)[0],anchor=lower??higher;
   const g=module.groups.find(x=>x.ids.includes(anchor))||module.groups.at(-1);
   if(!g){module.groups.push(taskGroup('Chức năng','Các chức năng của phân hệ',[n]));}else g.ids.push(n);
   placed.add(n);workspaceNavigationReport.autoAssigned.push(workspaceId(code,n));
  });
  module.groups=module.groups.filter(g=>g.ids.length);
  if(!contextualShortcuts[code])contextualShortcuts[code]=module.groups.flatMap(g=>g.primary).filter((n,i,a)=>a.indexOf(n)===i&&n>1).slice(0,4).map(n=>[n,list.find(s=>number(s)===n).title]);
  if(!moduleDescriptions[code])moduleDescriptions[code]='Chức năng của phân hệ '+module.name+'.';
 }
 Object.keys(workspaceModules).forEach(code=>{if(!byModule.has(code)){delete workspaceModules[code];workspaceNavigationReport.droppedModules.push(code)}});
 Object.keys(contextualShortcuts).forEach(code=>{if(!workspaceModules[code])delete contextualShortcuts[code];else contextualShortcuts[code]=contextualShortcuts[code].filter(([n])=>workspaceScreen(code,n))});
 workspaceAreas.forEach(a=>{a.modules=a.modules.filter(m=>workspaceModules[m])});
 const listed=new Set(workspaceAreas.flatMap(a=>a.modules)),extra=Object.keys(workspaceModules).filter(m=>!listed.has(m));
 if(extra.length){workspaceNavigationReport.extraAreaModules=extra;workspaceAreas.push({id:'more',name:'Phân hệ mở rộng',icon:'grid',modules:extra})}
 workspaceAreas.splice(0,workspaceAreas.length,...workspaceAreas.filter(a=>a.modules.length));
}
completeWorkspaceNavigation();
const adminLibraryModules=['IAM',...workspaceAreas.filter(a=>['admin','data'].includes(a.id)).flatMap(a=>a.modules)];
let favoriteScreens=['DIS-15','BI-02'];try{const saved=JSON.parse(localStorage.getItem('investment-favorites'));if(Array.isArray(saved))favoriteScreens=saved.filter(id=>SCREENS.some(s=>s.id===id&&s.platform==='web'))}catch{}
let navigationReturnFocus=null,applicationLibraryScope='all';const collapsedModules=new Set();const expandedModules=new Set([cur.module]);let pendingSidebarPosition=null;
function getWorkspaceContext(){const module=workspaceModules[cur.module],number=Number(cur.id.split('-')[1]),group=module?.groups.find(g=>g.ids.includes(number));return {module,number,group,area:workspaceAreas.find(a=>a.modules.includes(cur.module))}}
function saveFavoriteScreens(){try{localStorage.setItem('investment-favorites',JSON.stringify(favoriteScreens))}catch{}}
function toggleFavoriteScreen(id=cur.id){favoriteScreens=favoriteScreens.includes(id)?favoriteScreens.filter(x=>x!==id):[...favoriteScreens,id];saveFavoriteScreens();renderWorkspaceNavigation();toast(favoriteScreens.includes(id)?'Đã ghim vào thanh bên':'Đã bỏ ghim khỏi thanh bên')}
function reorderFavorite(id,direction){const i=favoriteScreens.indexOf(id),j=i+direction;if(j<0||j>=favoriteScreens.length)return;[favoriteScreens[i],favoriteScreens[j]]=[favoriteScreens[j],favoriteScreens[i]];saveFavoriteScreens();renderWorkspaceNavigation();openFavoriteSettings()}
function closeNavigationModal(){const modal=document.querySelector('.navigation-modal');if(!modal)return;modal.remove();navigationReturnFocus?.focus({preventScroll:true})}
function openFavoriteSettings(){document.querySelector('.navigation-modal')?.remove();navigationReturnFocus=document.querySelector('.favorites-manage');const panel=document.createElement('div');panel.className='navigation-modal';panel.innerHTML=`<section class="favorite-settings" role="dialog" aria-modal="true" aria-labelledby="favorites-title"><header><h2 id="favorites-title">Sắp xếp mục đã ghim</h2><button onclick="closeNavigationModal()" aria-label="Đóng">${workspaceIcon('close')}</button></header><p>Ghim chức năng bằng ngôi sao ở đầu trang. Thứ tự này được lưu trên trình duyệt của bạn.</p>${favoriteScreens.map((id,i)=>`<div class="favorite-settings-row"><span>${esc(SCREENS.find(s=>s.id===id).title)}</span><button onclick="reorderFavorite('${id}',-1)" aria-label="Đưa ${esc(id)} lên" ${i===0?'disabled':''}>↑</button><button onclick="reorderFavorite('${id}',1)" aria-label="Đưa ${esc(id)} xuống" ${i===favoriteScreens.length-1?'disabled':''}>↓</button><button onclick="toggleFavoriteScreen('${id}');openFavoriteSettings()" aria-label="Bỏ ghim ${esc(id)}">${workspaceIcon('close')}</button></div>`).join('')||'<p>Chưa có mục được ghim.</p>'}</section>`;document.body.append(panel);panel.addEventListener('pointerdown',e=>{if(e.target===panel)closeNavigationModal()});panel.querySelector('button').focus()}
function toggleContextModule(module){
 const button=document.querySelector(`[data-expand-module="${module}"]`);if(!button)return;
 const nav=button.closest('.single-sidebar-scroll'),scroll=nav.scrollTop;
 if(expandedModules.has(module)&&!collapsedModules.has(module)){collapsedModules.add(module);expandedModules.delete(module)}else{collapsedModules.delete(module);expandedModules.add(module)}
 const row=button.closest('.sidebar-destination');if(row.nextElementSibling?.classList.contains('sidebar-context'))row.nextElementSibling.remove();
 row.insertAdjacentHTML('afterend',sidebarContext(module));button.setAttribute('aria-expanded',String(expandedModules.has(module)));
 setSidebarScroll(nav,scroll);button.focus({preventScroll:true});
}
function setSidebarScroll(nav,scroll){
 // Retain enough trailing space when collapsing the last group so the browser
 // does not clamp scrollTop and move the control out from under the pointer.
 nav.style.paddingBottom='20px';
 const reserve=Math.max(0,scroll+nav.clientHeight-nav.scrollHeight);
 if(reserve)nav.style.paddingBottom=`${20+reserve}px`;
 nav.scrollTop=scroll;
}
function captureSidebarPosition(anchor=null){
 const nav=document.querySelector('.single-sidebar-scroll');if(!nav)return null;
 const focus=document.activeElement;return {scroll:nav.scrollTop,href:anchor?.getAttribute('href'),top:anchor?.getBoundingClientRect().top,focusHref:nav.contains(focus)?focus.getAttribute('href'):null};
}
function restoreSidebarPosition(position){
 const nav=document.querySelector('.single-sidebar-scroll');if(!nav||!position)return;
 setSidebarScroll(nav,position.scroll);
 const anchor=position.href?[...nav.querySelectorAll('a[href]')].find(a=>a.getAttribute('href')===position.href):null;
 if(anchor&&innerWidth>980){setSidebarScroll(nav,nav.scrollTop+anchor.getBoundingClientRect().top-position.top);anchor.focus({preventScroll:true})}
 else if(position.focusHref){[...nav.querySelectorAll('a[href]')].find(a=>a.getAttribute('href')===position.focusHref)?.focus({preventScroll:true})}
}
document.addEventListener('click',event=>{
 const link=event.target.closest('.single-sidebar-scroll a[href^="#"]');if(!link||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||event.button!==0)return;
 if(link.classList.contains('sidebar-link')&&link.closest('.sidebar-destination').querySelector('.sidebar-expand')){
  const module=link.hash.slice(1).split('-')[0];
  if(link.hash===location.hash){event.preventDefault();toggleContextModule(module);return}
  expandedModules.add(module);collapsedModules.delete(module);
 }
 if(link.hash===location.hash){event.preventDefault();pendingSidebarPosition=null;return}
 pendingSidebarPosition=captureSidebarPosition(link);
},true);

function sidebarContext(module){if(!expandedModules.has(module)||collapsedModules.has(module))return '';const shortcuts=contextualShortcuts[module]||[];const active=cur.module===module?Number(cur.id.split('-')[1]):-1;let rows=shortcuts.map(([n,title])=>`<a href="#${workspaceId(module,n)}" ${active===n?'aria-current="page"':''}><span>${esc(title)}</span></a>`).join('');if(active>1&&!shortcuts.some(([n])=>n===active))rows+=`<a class="current-context-leaf" href="#${cur.id}" aria-current="page"><span>${esc(cur.title)}</span></a>`;return `<div class="sidebar-context">${rows}<button class="all-module-tasks" onclick="openModuleDirectory('${module}')">Tất cả chức năng ${workspaceIcon('chevron')}</button></div>`}
function mainNavigationLink(id,label,icon,expand=false){const module=id.split('-')[0],exact=cur.id===id,active=expand?cur.module===module:exact;return `<div class="sidebar-destination ${active?'destination-active':''}"><a href="#${id}" class="sidebar-link" ${exact?'aria-current="page"':''}>${workspaceIcon(icon)}<span>${esc(label)}</span>${id==='NOT-01'&&typeof notificationInbox!=='undefined'&&notificationInbox.some(n=>n.unread)?`<span class="nav-count">${notificationInbox.filter(n=>n.unread).length}</span>`:''}</a>${expand?`<button data-expand-module="${module}" class="sidebar-expand" onclick="toggleContextModule('${module}')" aria-label="Hiện hoặc ẩn chức năng ${esc(label)}" aria-expanded="${expandedModules.has(module)&&!collapsedModules.has(module)}">${workspaceIcon('chevron')}</button>`:''}</div>${expand?sidebarContext(module):''}`}
function toggleWorkspaceDrawer(open){const shell=document.querySelector('.workspace-sidebar');if(!shell)return;const show=typeof open==='boolean'?open:!shell.classList.contains('drawer-open');shell.classList.toggle('drawer-open',show);document.querySelector('.workspace-drawer-shade')?.classList.toggle('visible',show);document.querySelector('.workspace-menu-toggle')?.setAttribute('aria-expanded',String(show));if(show){navigationReturnFocus=document.activeElement;shell.setAttribute('role','dialog');shell.setAttribute('aria-modal','true');shell.querySelector('.workspace-drawer-close').focus()}else{shell.removeAttribute('role');shell.removeAttribute('aria-modal');navigationReturnFocus?.focus()}}
function closeModuleDirectory(){const panel=$('module-directory');if(!panel)return;panel.remove();navigationReturnFocus?.focus()}
function openModuleDirectory(moduleCode=cur.module){closeModuleDirectory();navigationReturnFocus=document.activeElement;const module=workspaceModules[moduleCode];const panel=document.createElement('div');panel.id='module-directory';panel.className='module-directory';panel.innerHTML=`<section class="module-directory-panel" role="dialog" aria-modal="true" aria-labelledby="module-directory-title"><header><span class="directory-eyebrow">CHỨC NĂNG PHÂN HỆ</span><button onclick="closeModuleDirectory()" aria-label="Đóng danh mục chức năng">${workspaceIcon('close')}</button><h2 id="module-directory-title">${esc(module.name)}</h2><p>Chọn công việc bạn muốn thực hiện.</p></header><div class="directory-search">${workspaceIcon('search')}<input id="module-directory-query" aria-label="Tìm trong phân hệ" placeholder="Tìm chức năng…" oninput="filterModuleDirectory(this.value)"></div><div class="directory-sections">${module.groups.map(g=>`<section class="directory-group"><h3>${esc(g.title)}</h3>${g.ids.map(n=>{const screen=workspaceScreen(moduleCode,n);return `<a class="directory-link" href="#${screen.id}" onclick="closeModuleDirectory();toggleWorkspaceDrawer(false)" data-search="${esc(normalizedSearch(screen.id+' '+screen.title))}" ${screen.id===cur.id?'aria-current="page"':''}><span><strong>${esc(screen.title)}</strong><small>${g.primary.includes(n)?'Không gian làm việc':'Chi tiết & thao tác'}</small></span>${workspaceIcon('chevron')}</a>`}).join('')}</section>`).join('')}<p class="directory-empty" hidden>Không tìm thấy chức năng phù hợp.</p></div></section>`;document.body.append(panel);$('module-directory-query').focus();panel.addEventListener('pointerdown',e=>{if(e.target===panel)closeModuleDirectory()})}
function filterModuleDirectory(value){const q=normalizedSearch(value.trim());let count=0;document.querySelectorAll('.directory-group').forEach(group=>{let n=0;group.querySelectorAll('.directory-link').forEach(link=>{link.hidden=!q.split(/\s+/).every(w=>link.dataset.search.includes(w));if(!link.hidden)n++});group.hidden=!n;count+=n});document.querySelector('.directory-empty').hidden=count>0}
function openApplicationLibrary(scope='all'){closeNavigationModal();applicationLibraryScope=scope;navigationReturnFocus=document.activeElement;const modal=document.createElement('div');modal.className='navigation-modal application-library';modal.innerHTML=`<section class="application-library-panel" role="dialog" aria-modal="true" aria-labelledby="library-title"><header><div><span class="directory-eyebrow">KHÔNG GIAN CAO BẰNG</span><h2 id="library-title">${scope==='admin'?'Quản trị & cấu hình':'Tất cả ứng dụng'}</h2><p>${scope==='admin'?'Tổ chức, dữ liệu, AI và vận hành nền tảng.':'Chọn nghiệp vụ hoặc tìm trực tiếp chức năng cần dùng.'}</p></div><button onclick="closeNavigationModal()" aria-label="Đóng ứng dụng">${workspaceIcon('close')}</button></header><label class="library-search">${workspaceIcon('search')}<input id="application-query" aria-label="Tìm ứng dụng và chức năng" placeholder="Tìm ứng dụng, chức năng hoặc mã màn hình…" oninput="filterApplicationLibrary(this.value)"><kbd>Esc</kbd></label><div id="application-results"></div><footer>Menu thường dùng luôn ở thanh bên. Bạn có thể ghim bất kỳ màn hình nào để truy cập nhanh.</footer></section>`;document.body.append(modal);filterApplicationLibrary('');$('application-query').focus();modal.addEventListener('pointerdown',e=>{if(e.target===modal)closeNavigationModal()})}
function filterApplicationLibrary(query){const q=normalizedSearch(query.trim()),allowed=applicationLibraryScope==='admin'?adminLibraryModules:Object.keys(workspaceModules);const results=$('application-results');if(q){const found=SCREENS.filter(s=>s.platform==='web'&&allowed.includes(s.module)&&q.split(/\s+/).every(word=>normalizedSearch(`${s.id} ${s.title} ${s.moduleName}`).includes(word)));results.innerHTML=`<p class="library-result-count" role="status">${found.length} kết quả</p><div class="library-search-results">${found.map(s=>`<a href="#${s.id}" onclick="closeNavigationModal()"><span><strong>${esc(s.title)}</strong><small>${esc(workspaceModules[s.module].name)}</small></span>${workspaceIcon('chevron')}</a>`).join('')||'<p class="library-empty">Thử từ khóa ngắn hơn hoặc tên nghiệp vụ.</p>'}</div>`;return}results.innerHTML=workspaceAreas.map(area=>{const modules=area.modules.filter(m=>allowed.includes(m));return modules.length?`<section class="library-group"><h3>${esc(area.name)}</h3><div class="application-grid">${modules.map(m=>`<a class="application-card" href="#${workspaceId(m,1)}" onclick="closeNavigationModal()"><span class="application-card-icon">${workspaceIcon(area.icon)}</span><span><strong>${esc(workspaceModules[m].name)}</strong><small>${esc(moduleDescriptions[m])}</small></span>${workspaceIcon('chevron')}</a>`).join('')}</div></section>`:''}).join('')}
function mobileTabKey(screen){const n=Number(screen.id.split('-')[1]);if(!screen.id.startsWith('MOB-'))return screen.kind==='approval'||screen.module==='DOC'?'approval':'projects';return n>=47&&n<=54?'account':n>=32&&n<=36?'inbox':[23,24,25,26,65].includes(n)||(n>66&&screen.kind==='approval')?'approval':[7,8,40,58].includes(n)?'home':'projects'}
function renderMobileNavigation(){const n=Number(cur.id.split('-')[1]);if(n<=6)return;const bar=document.querySelector('.bottomnav');if(!bar)return;let selected=mobileTabKey(cur);const tabs=[['home','MOB-07','Trang chủ','home'],['projects','MOB-09','Dự án','investment'],['approval','MOB-23','Phê duyệt','task'],['inbox','MOB-32','Thông báo','inbox'],['account','MOB-47','Cá nhân','admin']];bar.setAttribute('aria-label','Điều hướng chính');bar.innerHTML=tabs.map(([key,id,label,icon])=>`<a href="#${id}" ${key===selected?'aria-current="page"':''}>${workspaceIcon(icon)}<span>${label}</span></a>`).join('');document.querySelector('.device')?.classList.add('refined-mobile');}
function renderWorkspaceNavigation(){
 const sidebarPosition=captureSidebarPosition();
 if(cur.platform==='mobile'){renderMobileNavigation();return}if(['IAM-01','IAM-02','IAM-03'].includes(cur.id))return;
 const {module,number,group}=getWorkspaceContext();if(!module||!group)return;const app=document.querySelector('.app'),sidebar=app.querySelector('.sidebar');if(!sidebar)return;document.querySelector('.modulelinks')?.remove();app.classList.add('workspace-app');sidebar.className='sidebar workspace-sidebar';sidebar.id='workspace-sidebar';
 const represented=['HOME','NOT',...quickModules.map(x=>x[0])].includes(cur.module);
 sidebar.innerHTML=`<div class="tenant-identity"><a href="#HOME-01" class="tenant-monogram" aria-label="Trang chủ Cao Bằng">CB<span></span></a><a href="#IAM-04" class="tenant-name"><strong>Cao Bằng</strong><span>Không gian làm việc ${workspaceIcon('chevron')}</span></a><button class="workspace-drawer-close" onclick="toggleWorkspaceDrawer(false)" aria-label="Đóng menu">${workspaceIcon('close')}</button></div><nav class="single-sidebar-scroll" aria-label="Điều hướng chính"><div class="personal-navigation">${mainNavigationLink('HOME-01','Tổng quan','home')}${mainNavigationLink('HOME-02','Việc của tôi','task')}${mainNavigationLink('NOT-01','Thông báo','inbox',true)}</div><section class="sidebar-section"><h2>Nghiệp vụ</h2>${quickModules.map(([m,label,icon])=>mainNavigationLink(workspaceId(m,1),label,icon,true)).join('')}${!represented?mainNavigationLink(workspaceId(cur.module,1),module.name,'grid',true):''}<button class="all-applications" onclick="openApplicationLibrary()">${workspaceIcon('grid')}<span>Tất cả ứng dụng</span>${workspaceIcon('chevron')}</button></section><section class="sidebar-section favorites-section"><h2>Đã ghim<button class="favorites-manage" onclick="openFavoriteSettings()" aria-label="Sắp xếp mục đã ghim">···</button></h2>${favoriteScreens.map(id=>{const screen=SCREENS.find(s=>s.id===id);return `<a class="favorite-link" href="#${id}" ${id===cur.id?'aria-current="page"':''}>${workspaceIcon('pin')}<span>${esc(screen.title)}</span></a>`}).join('')||'<p class="favorites-empty">Ghim công việc thường dùng bằng ngôi sao ở đầu trang.</p>'}</section></nav><footer class="single-sidebar-footer"><button onclick="openApplicationLibrary('admin')">${workspaceIcon('admin')}<span>Quản trị & cấu hình</span>${workspaceIcon('chevron')}</button><a href="#IAM-05" class="account-link"><span class="account-avatar">AN</span><span><strong>Nguyễn An</strong><small>Cán bộ quản lý · Bản mẫu</small></span><span>···</span></a></footer>`;
 const topbar=app.querySelector('.topbar');topbar.className='topbar workspace-topbar';topbar.innerHTML=`<button class="workspace-menu-toggle" onclick="toggleWorkspaceDrawer(true)" aria-label="Mở menu" aria-controls="workspace-sidebar" aria-expanded="false">${workspaceIcon('menu')}</button><nav class="workspace-breadcrumb" aria-label="Đường dẫn"><button onclick="openModuleDirectory()">${esc(module.name)}</button><span>/</span><strong>${esc(cur.title)}</strong></nav><div class="page-utilities"><span class="period-label">2026</span><button id="pin-current-screen" onclick="toggleFavoriteScreen()" aria-label="${favoriteScreens.includes(cur.id)?'Bỏ ghim màn hình':'Ghim màn hình'}" aria-pressed="${favoriteScreens.includes(cur.id)}" title="Ghim vào thanh bên">${workspaceIcon('star')}</button><a href="#IAM-08" aria-label="Trợ giúp">${workspaceIcon('help')}</a></div>`;
 app.querySelector('.workspace-drawer-shade')?.remove();app.insertAdjacentHTML('beforeend','<button class="workspace-drawer-shade" onclick="toggleWorkspaceDrawer(false)" aria-label="Đóng menu"></button>');
 const heading=app.querySelector('.heading');if(heading){const subtitle=heading.querySelector('p');if(subtitle)subtitle.textContent=moduleDescriptions[cur.module];if(cur.id==='NOT-01'&&$('state').value==='normal')heading.querySelector('.actions').innerHTML='<button onclick="go(\'NOT-03\')">Tùy chọn nhận tin</button><button class="primary" onclick="markNotificationInboxRead()">Đánh dấu tất cả đã đọc</button>';}
 app.querySelectorAll('.context-back').forEach(e=>e.remove());
 if(group.parents[number]){const parent=workspaceScreen(cur.module,group.parents[number]);heading?.insertAdjacentHTML('beforebegin',`<a class="context-back" href="#${parent.id}">← ${esc(parent.title)}</a>`)}
 restoreSidebarPosition(sidebarPosition);
}
const renderBeforeWorkspace=render;render=function(){
 const position=pendingSidebarPosition||captureSidebarPosition();pendingSidebarPosition=null;
 const next=SCREENS.find(s=>s.id===location.hash.slice(1));if(next?.platform==='web'&&!collapsedModules.has(next.module))expandedModules.add(next.module);
 renderBeforeWorkspace();renderWorkspaceNavigation();restoreSidebarPosition(position);
};

document.addEventListener('keydown',event=>{
 const directory=$('module-directory'),modal=document.querySelector('.navigation-modal'),drawer=document.querySelector('.workspace-sidebar.drawer-open');
 if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){if(directory)closeModuleDirectory();if(modal)closeNavigationModal();if(drawer)toggleWorkspaceDrawer(false);return}
 if(event.key==='Escape'){if(directory){event.preventDefault();closeModuleDirectory()}else if(modal){event.preventDefault();closeNavigationModal()}else if(drawer){event.preventDefault();toggleWorkspaceDrawer(false)}}
 const trap=directory||modal||drawer;if(event.key==='Tab'&&trap){const items=[...trap.querySelectorAll('a,button,input')].filter(e=>!e.disabled&&e.getClientRects().length&&!e.closest('[hidden]')),first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus()}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus()}}
});
window.addEventListener('hashchange',()=>{closeModuleDirectory();closeNavigationModal()});
const notificationInbox=[
 {id:'approval',title:'Hồ sơ thanh toán đang chờ phê duyệt',body:'Hồ sơ đợt 03 của dự án Hạ tầng khu tái định cư Thục Phán đã quá hạn xử lý. Kiểm tra chứng từ và thẩm quyền trước khi phê duyệt.',category:'Cần xử lý',project:'Hạ tầng khu tái định cư Thục Phán',time:'09:42',date:'22/10/2026',channel:'Ứng dụng · Email',route:'PAY-03',action:'Mở hồ sơ thanh toán',unread:true,requiresAction:true,tone:'amber',initial:'✓'},
 {id:'report',title:'Báo cáo giải ngân tuần đã được nộp',body:'Ban quản lý dự án đã hoàn tất gửi báo cáo tuần. Bạn có thể xem dữ liệu theo nguồn vốn, lịch sử cập nhật và tài liệu đính kèm.',category:'Báo cáo',project:'Trường mầm non Sông Hiến',time:'09:18',date:'22/10/2026',channel:'Ứng dụng',route:'DIS-07',action:'Xem chi tiết báo cáo',unread:true,requiresAction:false,tone:'teal',initial:'▤'},
 {id:'budget',title:'Ngân sách AI cần được rà soát',body:'Mức sử dụng AI đã chạm ngưỡng cảnh báo trong cấu hình. Rà soát usage theo tác vụ, model và đơn vị trước khi điều chỉnh hạn mức.',category:'Cần xử lý',project:'Không gian Cao Bằng · Quản trị AI',time:'08:56',date:'22/10/2026',channel:'Ứng dụng · Email',route:'LLM-07',action:'Rà soát ngân sách AI',unread:true,requiresAction:true,tone:'amber',initial:'✦'},
 {id:'license',title:'Lịch gia hạn license đã được cập nhật',body:'Thông tin kỳ hạn license đã được cập nhật trong hồ sơ thuê bao. Xem phạm vi tính năng và lịch sử thay đổi khi cần đối chiếu.',category:'Nền tảng',project:'Không gian Cao Bằng · Enterprise',time:'16:30',date:'21/10/2026',channel:'Ứng dụng',route:'SAS-13',action:'Xem thông tin license',unread:false,requiresAction:false,tone:'neutral',initial:'◇'}
];
let notificationInboxFilter='all',notificationInboxQuery='',notificationInboxSelection='approval';
function notificationInboxMarkup(){const unread=notificationInbox.filter(n=>n.unread).length,action=notificationInbox.filter(n=>n.requiresAction).length;return `<section class="notification-workspace"><div class="notification-summary"><div><span class="notification-summary-label">NHỊP CÔNG VIỆC HÔM NAY</span><h2>${unread?'Bạn có '+unread+' thông báo chưa đọc.':'Bạn đã đọc hết thông báo.'}</h2><p>Ưu tiên hồ sơ cần xử lý, theo dõi thông tin còn lại trong cùng một nơi.</p></div><button onclick="setNotificationInboxFilter('action')"><strong>${action}</strong><span>Cần xử lý ${workspaceIcon('chevron')}</span></button></div><div class="notification-desk"><section class="inbox-card"><div class="inbox-tabs" role="group" aria-label="Lọc hộp thông báo"><button data-inbox-filter="all" onclick="setNotificationInboxFilter('all')">Tất cả <span>${notificationInbox.length}</span></button><button data-inbox-filter="unread" onclick="setNotificationInboxFilter('unread')">Chưa đọc <span>${unread}</span></button><button data-inbox-filter="action" onclick="setNotificationInboxFilter('action')">Cần xử lý <span>${action}</span></button></div><label class="inbox-search">${workspaceIcon('search')}<input id="notification-inbox-query" value="${esc(notificationInboxQuery)}" oninput="notificationInboxQuery=this.value;updateNotificationInbox()" placeholder="Tìm theo nội dung hoặc dự án…" aria-label="Tìm thông báo"></label><div class="notification-items"></div><footer class="inbox-list-footer">Dữ liệu minh họa · 22/10/2026</footer></section><aside class="notification-preview" aria-label="Nội dung thông báo"></aside></div></section>`}
function setNotificationInboxFilter(filter){notificationInboxFilter=filter;updateNotificationInbox()}
function selectNotificationInbox(id){notificationInboxSelection=id;updateNotificationInbox();if(innerWidth<=720||cur.platform==='mobile'){document.querySelector('.notification-desk')?.classList.add('preview-open');document.querySelector('.notification-preview')?.scrollIntoView({block:'start'})}}
function returnToNotificationList(){if(cur.id==='NOT-02'||cur.id==='MOB-33'){go(cur.platform==='mobile'?'MOB-32':'NOT-01');return}document.querySelector('.notification-desk')?.classList.remove('preview-open')}
function markNotificationInboxRead(){notificationInbox.forEach(n=>n.unread=false);render();toast('Đã đánh dấu đã đọc trong bản mô phỏng')}
function markSelectedNotificationRead(){const item=notificationInbox.find(n=>n.id===notificationInboxSelection);if(item)item.unread=false;render()}
function updateNotificationInbox(){
 const list=document.querySelector('.notification-items');if(!list)return;const q=normalizedSearch(notificationInboxQuery),items=notificationInbox.filter(n=>(notificationInboxFilter!=='unread'||n.unread)&&(notificationInboxFilter!=='action'||n.requiresAction)&&normalizedSearch(n.title+' '+n.body+' '+n.project).includes(q));
 document.querySelectorAll('[data-inbox-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.inboxFilter===notificationInboxFilter)));
 if(!items.some(n=>n.id===notificationInboxSelection))notificationInboxSelection=items[0]?.id||null;
 list.innerHTML=items.length?items.map(n=>`<button class="notification-row ${n.id===notificationInboxSelection?'selected':''}" onclick="selectNotificationInbox('${n.id}')" aria-pressed="${n.id===notificationInboxSelection}"><span class="notification-symbol ${n.tone}">${n.initial}</span><span class="notification-copy"><span class="notification-category">${n.category}<time>${n.time}</time></span><strong>${esc(n.title)}</strong><small>${esc(n.project)}</small></span><span class="notification-unread ${n.unread?'unread':''}" aria-label="${n.unread?'Chưa đọc':'Đã đọc'}"></span></button>`).join(''):'<div class="notification-empty"><strong>Không có thông báo phù hợp</strong><p>Thử đổi bộ lọc hoặc nội dung tìm kiếm.</p></div>';
 const item=items.find(n=>n.id===notificationInboxSelection),preview=document.querySelector('.notification-preview');preview.innerHTML=item?`<button class="inbox-mobile-back" onclick="returnToNotificationList()">← Danh sách thông báo</button><div class="notification-preview-head"><span class="notification-status ${item.tone}">${item.category}</span><span>${item.unread?'Chưa đọc':'Đã đọc'}</span></div><h2>${esc(item.title)}</h2><p class="notification-preview-time">${item.time} · ${item.date}</p><p class="notification-preview-body">${esc(item.body)}</p><dl><dt>Phạm vi liên quan</dt><dd>${esc(item.project)}</dd><dt>Kênh tiếp nhận</dt><dd>${item.channel}</dd></dl><a class="notification-primary-action" href="#${cur.platform==='mobile'?({approval:'MOB-24',report:'MOB-20',budget:'MOB-37',license:'MOB-47'}[item.id]):item.route}">${cur.platform==='mobile'?({approval:'Xem hồ sơ phê duyệt',report:'Xem báo cáo',budget:'Hỏi đáp về cảnh báo',license:'Mở tài khoản'}[item.id]):item.action}<span>↗</span></a>${item.unread?'<button class="notification-read-action" onclick="markSelectedNotificationRead()">Đánh dấu thông báo này đã đọc</button>':''}<p class="notification-demo-note">Trạng thái đọc chỉ thay đổi trong phiên mô phỏng này.</p>`:'<div class="notification-empty"><strong>Chưa có thông báo được chọn</strong><p>Nội dung sẽ xuất hiện tại đây.</p></div>';
}
const contentBeforeInbox=content;content=function(){if(cur.id==='NOT-01'||cur.id==='MOB-32')return notificationInboxMarkup();if(cur.id==='NOT-02'||cur.id==='MOB-33')return '<section class="standalone-notification card"><div class="notification-items" hidden></div><article class="notification-preview" aria-label="Chi tiết thông báo"></article></section>';return contentBeforeInbox()};
function refineSharedControls(){
 const root=document.querySelector('#screen-capture');if(!root)return;
 root.querySelectorAll('.card').forEach(card=>{const eyebrow=card.querySelector(':scope > .eyebrow');if(eyebrow?.textContent==='Ngữ cảnh làm việc'){if(cur.platform==='mobile'){card.remove();return}const note=card.querySelector(':scope > .sub');if(note)note.textContent='Bản nháp chưa được gửi. Kiểm tra nội dung và người nhận trước khi tiếp tục.'}});
 root.querySelectorAll('input,select,textarea').forEach((control,i)=>{
  if(control.labels?.length||control.hasAttribute('aria-label')||control.hasAttribute('aria-labelledby'))return;
  const previous=control.previousElementSibling;
  if(previous?.tagName==='LABEL'){if(!control.id)control.id=`${cur.id}-control-${i}`;previous.htmlFor=control.id;return}
  const name=control.type==='file'?'Chọn tài liệu đính kèm':control.placeholder||((control.tagName==='SELECT'&&control.options[0]?.text==='Toàn danh mục')?'Phạm vi nguồn vốn':null);
  if(name)control.setAttribute('aria-label',name);
 });
 const actions=root.querySelector('.heading .actions');
 if(actions&&['dashboard','rank','map','search','timeline','chart','detail','success','error','offline','empty'].includes(cur.kind)){
  const generic=actions.querySelector('button[onclick="next()"]');if(generic){generic.textContent='Chức năng liên quan';generic.setAttribute('onclick','openModuleDirectory()')}
 }
}
const renderBeforeInbox=render;render=function(){renderBeforeInbox();updateNotificationInbox();refineSharedControls()};
render();
