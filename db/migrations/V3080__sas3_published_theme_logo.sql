-- Authored by hand (not generated): the logo of the theme in force, for the tenant plane (getMyThemeLogo, ST-SAS-005).
--
-- The tenant plane still reads no asset row (V019): it reads this view, which holds one row at most, the logo the published version names,
-- and only once its scan found it clean. A logo of a draft, of an older version or of another tenant is never in it. The tenant is the one of
-- the transaction (app.tenant_id), named in the view itself as well as by the row-level security of the tables under it.
CREATE OR REPLACE VIEW machvon.published_theme_logo WITH (security_barrier = true) AS
SELECT a.tenant_id, a.id, a.content_hash, a.mime, a.storage_key
  FROM machvon.tenant_theme_pointer p
  JOIN machvon.tenant_theme_version v ON v.tenant_id = p.tenant_id AND v.version = p.current_version
  JOIN machvon.tenant_theme_asset a ON a.tenant_id = v.tenant_id AND a.id::text = v.config_json ->> 'logoAssetId'
 WHERE a.scan_status = 'clean'
   AND p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid;

GRANT SELECT ON machvon.published_theme_logo TO machvon_app;
