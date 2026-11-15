-- Unsubscribe (one-click / email / link). Logged in action_log; retire items remember the
-- newest message from each sender (sample_ref) so its unsubscribe header can be fetched on tap.
alter table public.action_log drop constraint action_log_action_check;
alter table public.action_log add constraint action_log_action_check
  check (action in ('archive', 'unarchive', 'snooze', 'unsnooze', 'create_filter', 'delete_filter', 'reply', 'unsubscribe'));

alter table public.retire_items
  add column sample_ref jsonb,              -- { path, uid } (IMAP) or { id } (Gmail / Microsoft)
  add column unsubscribed_at timestamptz,
  add column unsubscribe_method text check (unsubscribe_method in ('one-click', 'email', 'link'));
