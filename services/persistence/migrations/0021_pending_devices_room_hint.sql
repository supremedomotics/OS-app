-- Universal Room Intelligence for Pending Approval (§ Priority 4): a driver-reported room hint
-- (a Casambi Group name, an ETS Function/Space, …) needs to survive from discovery through to
-- approval so approvePendingDevice() can resolve it via the SAME shared resolveOrCreateRoom()
-- the direct-commission path already uses. Purely additive and nullable — existing rows are
-- unaffected, no backfill needed (pending_devices is ephemeral, refreshed on every scan anyway).
ALTER TABLE pending_devices ADD COLUMN IF NOT EXISTS room_hint TEXT;
