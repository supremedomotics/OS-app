-- Persist the native-migration routing (§4, §16) so a domain migrated to the
-- Supreme-native engine stays native across a hub restart. One row per backend domain.
CREATE TABLE IF NOT EXISTS migration_policy (
  domain TEXT PRIMARY KEY,
  engine TEXT NOT NULL
);
