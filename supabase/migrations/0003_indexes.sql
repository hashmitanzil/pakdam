create index if not exists idx_rooms_code on rooms(room_code);
create index if not exists idx_room_events_room_seq on room_events(room_id, seq);
create index if not exists idx_players_room on players(room_id);
create index if not exists idx_catches_room_state on catches(room_id, state);
create index if not exists idx_audit_created on audit_log(created_at);
create index if not exists idx_grievances_status on grievances(status);
