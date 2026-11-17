/**
 * The tables the dashboard is computed from, in the shape the owner's template reads them (template/engine.js). Money is in million đồng,
 * days are ISO dates, a flag is 0 or 1. A table is filled from the system where the system holds that data and from the illustrative
 * tables of the template (data/mock.json) where it does not: `sources/` decides, table by table.
 */
export interface UnitRow { ma: string; ten: string; ten_ngan: string; khoi: string; da_nop_so: number }
export interface ProjectRow {
  ma: string; ten: string; dia_ban: string; linh_vuc: string; tong_muc: number; giai_doan: string; don_vi: string; nhom: string;
  ngay_cham: number; nguyen_nhan: string | null; dung_yen: number; ngay_o_giai_doan: number; moi_chuyen_do: number;
  kho_bac_sau_ky: number; kho_bac_7_ngay: number; kh_NSTW: number; kh_NSDP: number; kh_SUPPORT: number; kh_ODAV: number;
}
export interface DisbursementRow { du_an: string; nguon: string; thang: number; so_tien: number | null }
export interface SubmissionRow { ma: string; loai: string; noi_dung: string; don_vi: string; du_an: string | null; ngay_nhan: string | null; han: string }
export interface AssignmentRow {
  ma: string; nhiem_vu_goc: string; noi_dung: string; don_vi: string; khoi: string; ngay_giao: string; han_noi_bo: string; buoc: string;
  ngay_xac_nhan: string | null; ngay_nop: string | null; ngay_chap_nhan: string | null; co_minh_chung: number; vuong_mac: string | null; cap_nhat_cuoi: string;
}
export interface ClockRow { hom_nay: string; nam: number; thang_chot: number; ngay_chot_so: string; kho_bac_den: string; nhiem_vu_den: string; ghi_chu: string }
export interface TargetRow { thang: number; muc_tieu_pct: number; cung_ky_pct: number }
export interface FundSourceRow { ma: string; ten: string; thu_tuong_giao: number; ke_hoach: number; chua_phan_bo: number }
export interface TaskRow {
  ma: string; loai: string; nhom: string; noi_dung: string; du_an: string | null; don_vi: string; la_moc: number; cho_duyet: number;
  han: string | null; ngay_xong: string | null; ngay_tre: number; trang_thai: string; cuoc_hop: string | null; van_ban: string | null;
}
export interface RootTaskRow {
  ma: string; nguon: string; nguon_ten: string; chuyen_de: string; noi_dung: string; han_bao_cao: string; ngay_ban_hanh: string;
  van_ban: string; loai_van_ban: string; chu_tri: string; uu_tien: string; ngay_chap_nhan: string | null;
}

export interface DashboardDb {
  don_vi: UnitRow[];
  du_an: ProjectRow[];
  giai_ngan: DisbursementRow[];
  ho_so_trinh: SubmissionRow[];
  luot_giao: AssignmentRow[];
  moc_thoi_gian: ClockRow[];
  muc_tieu: TargetRow[];
  nguon_von: FundSourceRow[];
  nhiem_vu: TaskRow[];
  nv_goc: RootTaskRow[];
}

export type DashboardTable = keyof DashboardDb;
/** Where a table of the dashboard came from: the system, or the illustrative tables of the template. */
export type TableOrigin = 'system' | 'template';
