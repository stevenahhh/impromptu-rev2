SET ROLE impromptu_owner;

ALTER TABLE public_projection.projection_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_projection.projection_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_internal ON public_projection.projection_sessions
  AS PERMISSIVE FOR ALL TO impromptu_owner
  USING (true)
  WITH CHECK (true);

ALTER TABLE public_projection.audience_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_projection.audience_cards FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_internal ON public_projection.audience_cards
  AS PERMISSIVE FOR ALL TO impromptu_owner
  USING (true)
  WITH CHECK (true);

ALTER TABLE public_projection.display_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public_projection.display_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY owner_internal ON public_projection.display_receipts
  AS PERMISSIVE FOR ALL TO impromptu_owner
  USING (true)
  WITH CHECK (true);

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public_projection FROM private_app;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public_projection FROM private_app;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public_projection FROM private_app;
REVOKE USAGE ON TYPE public_projection.projection_state FROM private_app;
REVOKE USAGE ON TYPE public_projection.card_lifecycle FROM private_app;
REVOKE USAGE ON TYPE public_projection.receipt_status FROM private_app;
REVOKE USAGE ON SCHEMA public_projection FROM private_app;
