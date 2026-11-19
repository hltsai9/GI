-- Test users for DEV_AUTH=true (no SSO yet). Applied at startup whenever DEV_AUTH is true.
INSERT IGNORE INTO app_user (sso_subject, name, role) VALUES
  ('dev-floor', 'Dana (floor staff)', 'floor'),
  ('dev-lead',  'Lee (cleanroom lead)', 'lead'),
  ('dev-admin', 'Avery (admin)', 'admin'),
  ('dev-viewer','Vic (viewer)', 'viewer');

